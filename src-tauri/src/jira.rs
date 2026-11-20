use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JiraConfig {
    pub email: String,
    pub token_mode: String,
    pub cloud_id: Option<String>,
}

pub(super) fn jira_validate(c: &ConnectionRecord) -> Result<(), String> {
    let site =
        reqwest::Url::parse(&c.base_url).map_err(|_| "Enter a valid Jira Cloud site URL.")?;
    if site.scheme() != "https"
        || !site
            .host_str()
            .is_some_and(|h| h.ends_with(".atlassian.net"))
        || site.path() != "/"
        || site.query().is_some()
        || site.fragment().is_some()
        || !site.username().is_empty()
        || site.password().is_some()
        || site.port().is_some()
    {
        return Err(
            "Use the Jira Cloud site URL, for example https://company.atlassian.net.".into(),
        );
    }
    let config = c
        .jira
        .as_ref()
        .ok_or("Jira account email and token mode are required.")?;
    if config.email.trim().is_empty() {
        return Err("Jira account email is required.".into());
    }
    if !matches!(config.token_mode.as_str(), "scoped" | "unscoped") {
        return Err("Choose scoped or unscoped Jira token mode.".into());
    }
    Ok(())
}

fn jira_timestamp_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .or_else(|_| chrono::DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn jira_headers(c: &ConnectionRecord) -> Result<Vec<(&'static str, String)>, String> {
    jira_validate(c)?;
    let email = &c.jira.as_ref().unwrap().email;
    Ok(vec![(
        "Authorization",
        format!(
            "Basic {}",
            STANDARD.encode(format!("{}:{}", email.trim(), c.token.trim()))
        ),
    )])
}

fn jira_cloud_id(c: &ConnectionRecord) -> Result<String, String> {
    let data = fetch_json(
        &format!("{}/_edge/tenant_info", c.base_url.trim_end_matches('/')),
        vec![],
    )?;
    json_string(&data, "cloudId")
        .filter(|v| v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .ok_or_else(|| "Could not resolve the Jira Cloud ID.".into())
}

fn jira_root(c: &ConnectionRecord) -> Result<String, String> {
    jira_validate(c)?;
    let config = c.jira.as_ref().unwrap();
    if config.token_mode == "scoped" {
        let cloud_id = config
            .cloud_id
            .clone()
            .map(Ok)
            .unwrap_or_else(|| jira_cloud_id(c))?;
        if cloud_id.is_empty()
            || !cloud_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid Jira Cloud ID.".into());
        }
        Ok(format!(
            "https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3"
        ))
    } else {
        Ok(format!("{}/rest/api/3", c.base_url.trim_end_matches('/')))
    }
}

fn jira_http(
    method: reqwest::Method,
    url: &str,
    headers: Vec<(&str, String)>,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(db_error)?;
    let mut request = client
        .request(method, url)
        .header("Accept", "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(payload) = payload {
        request = request.json(payload);
    }
    let response = request
        .send()
        .map_err(|e| format!("Jira request failed: {}", e.without_url()))?;
    let status = response.status();
    let body = response.text().map_err(db_error)?;
    if !status.is_success() {
        let detail =
            serde_json::from_str::<Value>(&body)
                .ok()
                .map(|v| {
                    let mut messages = v["errorMessages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    if let Some(fields) = v["errors"].as_object() {
                        messages.extend(fields.iter().map(|(k, v)| {
                            format!("{k}: {}", v.as_str().unwrap_or("Invalid value"))
                        }));
                    }
                    messages.join("; ")
                })
                .unwrap_or_default();
        return Err(format!(
            "Jira returned {status}{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    serde_json::from_str(&body).map_err(|_| "Jira returned an invalid JSON response.".into())
}

fn jira_get(c: &ConnectionRecord, path: &str) -> Result<Value, String> {
    jira_http(
        reqwest::Method::GET,
        &format!("{}{path}", jira_root(c)?),
        jira_headers(c)?,
        None,
    )
}

pub(super) fn jira_prepare_input(input: &mut ConnectionInput) -> Result<(), String> {
    input.base_url = normalize_base_url(&input.base_url).to_lowercase();
    let c = connection_record_from_test_input(ConnectionInput {
        id: input.id.clone(),
        provider: input.provider.clone(),
        name: input.name.clone(),
        base_url: input.base_url.clone(),
        api_key: None,
        token: input.token.clone(),
        jira: input.jira.clone(),
    });
    validate_connection_credentials(&c)?;
    if input.jira.as_ref().unwrap().token_mode == "scoped" {
        let cloud_id = jira_cloud_id(&c)?;
        input.jira.as_mut().unwrap().cloud_id = Some(cloud_id);
    } else {
        input.jira.as_mut().unwrap().cloud_id = None;
    }
    Ok(())
}

pub(super) fn jira_test_connection(c: &ConnectionRecord) -> Result<Option<String>, String> {
    let me = jira_get(c, "/myself")?;
    // Check issue read access independently of create permissions.
    jira_get(
        c,
        "/search/jql?jql=assignee%20%3D%20currentUser()&maxResults=1&fields=id",
    )?;
    Ok(json_string(&me, "displayName"))
}

pub(super) fn jira_identity(c: &ConnectionRecord, id: &str) -> String {
    format!("{}:{id}", host_from_url(&c.base_url).unwrap_or_default())
}

fn jira_id(value: &str) -> &str {
    value.rsplit(':').next().unwrap_or(value)
}
fn jira_url(c: &ConnectionRecord, key: &str) -> String {
    format!(
        "{}/browse/{}",
        c.base_url.trim_end_matches('/'),
        percent_encode(key)
    )
}

// Jira uses Atlassian Document Format. Preserve readable structure and link targets.
pub(super) fn jira_document_text(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.to_string();
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "text" {
        let text = v.get("text").and_then(Value::as_str).unwrap_or_default();
        let href = v
            .get("marks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|m| m["type"] == "link")
            .and_then(|m| m["attrs"]["href"].as_str());
        return href
            .map(|url| format!("[{text}]({url})"))
            .unwrap_or_else(|| text.into());
    }
    if kind == "hardBreak" {
        return "\n".into();
    }
    if kind == "mention" {
        return v["attrs"]["text"].as_str().unwrap_or("@user").into();
    }
    if kind == "inlineCard" {
        return v["attrs"]["url"].as_str().unwrap_or_default().into();
    }
    let content = v
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(jira_document_text)
        .collect::<String>();
    match kind {
        "paragraph" | "heading" => format!("{content}\n\n"),
        "listItem" => format!("- {}\n", content.trim()),
        "codeBlock" => format!("```\n{}\n```\n\n", content.trim_end()),
        "blockquote" => format!("> {}\n\n", content.trim()),
        _ => content,
    }
}

fn jira_document(text: &str) -> Value {
    serde_json::json!({"type":"doc", "version":1,"content":text.split('\n').map(|line| {
        if line.is_empty() { serde_json::json!({"type":"paragraph","content":[]}) }
        else { serde_json::json!({"type":"paragraph","content":[{"type":"text","text":line}]}) }
    }).collect::<Vec<_>>()})
}

// Offset-paginated endpoints must never silently truncate histories/comments.
fn jira_pages(c: &ConnectionRecord, path: &str, field: &str) -> Result<Vec<Value>, String> {
    jira_collect_pages(field, |start| {
        let sep = if path.contains('?') { '&' } else { '?' };
        jira_get(c, &format!("{path}{sep}startAt={start}&maxResults=100"))
    })
}

fn jira_collect_pages(
    field: &str,
    mut fetch: impl FnMut(usize) -> Result<Value, String>,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut start = 0;
    loop {
        let page = fetch(start)?;
        let values = page
            .get(field)
            .and_then(Value::as_array)
            .ok_or("Invalid Jira paginated response.")?;
        let count = values.len();
        items.extend(values.iter().cloned());
        start += count;
        if page["isLast"] == true || page["total"].as_u64().is_some_and(|n| start as u64 >= n) {
            break;
        }
        if count == 0 {
            return Err("Jira returned an incomplete paginated response.".into());
        }
    }
    Ok(items)
}

fn jira_search(c: &ConnectionRecord, jql: &str) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut next: Option<String> = None;
    let mut seen = HashSet::new();
    loop {
        let mut path = format!("/search/jql?jql={}&maxResults=100&fields=summary,description,status,project,creator,created,updated,labels", percent_encode(jql));
        if let Some(token) = &next {
            path.push_str(&format!("&nextPageToken={}", percent_encode(token)));
        }
        let page = jira_get(c, &path)?;
        items.extend(
            page["issues"]
                .as_array()
                .ok_or("Invalid Jira search response.")?
                .iter()
                .cloned(),
        );
        next = json_string(&page, "nextPageToken");
        if page["isLast"] == true || next.is_none() {
            break;
        }
        if !seen.insert(next.clone().unwrap()) {
            return Err("Jira repeated a search page token.".into());
        }
    }
    Ok(items)
}

fn jira_comments(c: &ConnectionRecord, issue_id: &str) -> Result<Vec<Value>, String> {
    jira_pages(
        c,
        &format!("/issue/{}/comment", percent_encode(issue_id)),
        "comments",
    )
}

fn jira_metadata(c: &ConnectionRecord, issue: &Value, comments: &[Value]) -> ProviderMetadata {
    let f = &issue["fields"];
    let key = issue["key"].as_str().unwrap_or_default();
    let url = jira_url(c, key);
    let category = f["status"]["statusCategory"]["key"]
        .as_str()
        .unwrap_or("new");
    ProviderMetadata {
        connection_id: Some(c.id.clone()),
        title: json_string(f, "summary"),
        body: Some(jira_document_text(&f["description"]).trim().to_string()),
        state: json_path_string(f, &["status", "name"]),
        // Provider status category persisted independently of the localized status label.
        state_color: None,
        state_category: Some(category.to_string()),
        url: Some(url.clone()),
        fetched_at: Some(now_millis()),
        labels: f["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(|name| ExternalLabel {
                name: name.into(),
                color: None,
            })
            .collect(),
        comments: comments
            .iter()
            .filter_map(|comment| {
                let id = json_string(comment, "id")?;
                Some(TaskComment {
                    id: format!("jira:{id}"),
                    author: json_path_string(comment, &["author", "displayName"])
                        .unwrap_or_else(|| "Unknown".into()),
                    body: jira_document_text(&comment["body"]).trim().into(),
                    url: Some(format!("{url}?focusedCommentId={id}")),
                    created_at: json_string(comment, "created"),
                    updated_at: json_string(comment, "updated"),
                    kind: "comment".into(),
                    discussion_id: None,
                    reply_to_id: None,
                    code_context: None,
                })
            })
            .collect(),
        parent_resource: Some(jira_project_metadata(c, &f["project"])),
        ..ProviderMetadata::empty()
    }
}

fn jira_project_metadata(c: &ConnectionRecord, project: &Value) -> ProviderResourceMetadata {
    let id = project["id"].as_str().unwrap_or_default();
    let key = project["key"].as_str().unwrap_or(id);
    ProviderResourceMetadata {
        provider: "jira".into(),
        kind: "jira_project".into(),
        external_id: jira_identity(c, id),
        url: format!(
            "{}/projects/{}",
            c.base_url.trim_end_matches('/'),
            percent_encode(key)
        ),
        name: project["name"].as_str().unwrap_or(key).into(),
        icon_url: None,
    }
}

fn jira_validate_issue(issue: &Value) -> Result<(), String> {
    if [
        issue["id"].as_str(),
        issue["key"].as_str(),
        issue["fields"]["summary"].as_str(),
        issue["fields"]["project"]["id"].as_str(),
        issue["fields"]["status"]["name"].as_str(),
    ]
    .iter()
    .any(|v| v.is_none())
    {
        return Err("Jira returned incomplete issue details. Cached details were kept.".into());
    }
    Ok(())
}

pub(super) fn jira_fetch_metadata(
    c: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let id = parsed
        .external_id
        .as_deref()
        .map(jira_id)
        .ok_or("Missing Jira issue ID.")?;
    let issue = jira_get(c, &format!("/issue/{}", percent_encode(id)))?;
    jira_validate_issue(&issue)?;
    let comments = jira_comments(c, issue["id"].as_str().ok_or("Missing Jira issue ID.")?)?;
    Ok(jira_metadata(c, &issue, &comments))
}

pub(super) fn jira_import(
    db: &SqliteConnection,
    parsed: ParsedInputPayload,
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let response = parsed_response(&parsed);
    let Some(project_id) = project_id else {
        return Ok(SmartTaskResult {
            task: None,
            resource: None,
            parsed: response,
            project_required: true,
            created: false,
            notice: None,
        });
    };
    let c = select_best_connection(db, &project_id, &parsed)
        .map_err(db_error)?
        .ok_or(
            "Enable a matching Jira connection and choose an account when more than one matches.",
        )?;
    let id = parsed
        .external_id
        .as_deref()
        .map(jira_id)
        .ok_or("Missing Jira ID.")?;
    if parsed.kind == "jira_project" {
        let project = jira_get(&c, &format!("/project/{}", percent_encode(id)))?;
        let m = jira_project_metadata(&c, &project);
        let resource = connect_resource_in_db(
            db,
            ResourceInput {
                project_id,
                provider: m.provider,
                kind: m.kind,
                external_id: m.external_id,
                url: m.url,
                name: m.name,
                icon_url: None,
                connection_id: Some(c.id),
            },
        )
        .map_err(db_error)?;
        return Ok(SmartTaskResult {
            task: None,
            resource: Some(resource),
            parsed: response,
            project_required: false,
            created: false,
            notice: Some("Jira project connected.".into()),
        });
    }
    let issue = jira_get(&c, &format!("/issue/{}", percent_encode(id)))?;
    jira_validate_issue(&issue)?;
    let immutable_id = issue["id"].as_str().ok_or("Jira returned no issue ID.")?;
    let canonical = jira_identity(&c, immutable_id);
    if let Some(task) = get_task_by_link(db, "jira", "jira_issue", &canonical).map_err(db_error)? {
        return Ok(SmartTaskResult {
            task: Some(task),
            resource: None,
            parsed: response,
            project_required: false,
            created: false,
            notice: None,
        });
    }
    let comments = jira_comments(&c, immutable_id)?;
    let metadata = jira_metadata(&c, &issue, &comments);
    let resource = upsert_parent_resource_in_db(db, &project_id, &parsed, Some(&metadata))
        .map_err(db_error)?;
    let task = create_task_in_db(
        db,
        Some(project_id),
        metadata.title.clone().unwrap_or(parsed.title),
        metadata.body.clone().unwrap_or_default(),
        metadata.url.clone(),
    )
    .map_err(db_error)?;
    link_task_resource_in_db(
        db,
        task.id.clone(),
        "jira".into(),
        "jira_issue".into(),
        canonical,
        metadata.url.clone().unwrap(),
        &metadata,
    )
    .map_err(db_error)?;
    db.execute(
        "UPDATE tasks SET status = ?1 WHERE id = ?2",
        params![metadata.state, task.id],
    )
    .map_err(db_error)?;
    Ok(SmartTaskResult {
        task: get_task(db, &task.id).map_err(db_error)?,
        resource,
        parsed: response,
        project_required: false,
        created: true,
        notice: None,
    })
}

pub(super) fn jira_assigned_issues(
    c: &ConnectionRecord,
) -> Result<Vec<SmartInboxReviewRequest>, String> {
    Ok(jira_search(
        c,
        "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    )?
    .iter()
    .filter_map(|issue| jira_assigned_issue_from_json(c, issue))
    .collect())
}

fn jira_assigned_issue_from_json(
    c: &ConnectionRecord,
    issue: &Value,
) -> Option<SmartInboxReviewRequest> {
    let f = &issue["fields"];
    let key = issue["key"].as_str()?;
    let updated_at = json_string(f, "updated").and_then(|v| jira_timestamp_millis(&v));
    let created_at = json_string(f, "created").and_then(|v| jira_timestamp_millis(&v));
    Some(SmartInboxReviewRequest {
        provider: "jira".into(),
        connection_id: c.id.clone(),
        connection_name: c.name.clone(),
        source_id: jira_identity(c, f["project"]["id"].as_str()?),
        source_name: f["project"]["name"].as_str()?.into(),
        external_id: jira_identity(c, issue["id"].as_str()?),
        title: f["summary"].as_str()?.into(),
        url: jira_url(c, key),
        context_path: Some(format!(
            "{} · {}",
            host_from_url(&c.base_url).unwrap_or_default(),
            f["project"]["key"].as_str().unwrap_or_default()
        )),
        context_detail: json_path_string(f, &["status", "name"]),
        number: Some(key.into()),
        author: None,
        review_requested_at: None,
        updated_at,
        created_at,
        sort_at: updated_at,
        sort_source: "updated".into(),
        state: f["status"]["name"].as_str().unwrap_or_default().into(),
        linked_task: None,
    })
}

fn jira_event(
    c: &ConnectionRecord,
    issue: &Value,
    event: &Value,
    author: &Value,
    me: &str,
    id: String,
    kind: &str,
    label: String,
    time: &str,
    start: i64,
    end: i64,
) -> Option<ActivityInput> {
    if author["accountId"].as_str()? != me {
        return None;
    }
    let occurred_at = jira_timestamp_millis(time)?;
    if occurred_at < start || occurred_at >= end {
        return None;
    }
    Some(ActivityInput {
        provider: "jira".into(),
        connection_id: c.id.clone(),
        external_id: format!("{}:{id}", issue["id"].as_str()?),
        event_type: kind.into(),
        action_label: label,
        actor: json_string(author, "displayName"),
        title: issue["fields"]["summary"].as_str()?.into(),
        target_url: Some(jira_url(c, issue["key"].as_str()?)),
        occurred_at,
        raw_json: serde_json::json!({"issue":issue,"event":event}).to_string(),
        subject_json: Some(issue.to_string()),
    })
}

pub(super) fn jira_activities(
    c: &ConnectionRecord,
    start: i64,
    end: i64,
) -> Result<Vec<ActivityInput>, String> {
    let me = jira_get(c, "/myself")?;
    let account = me["accountId"]
        .as_str()
        .ok_or("Jira returned no account ID.")?;
    // Search one day earlier to cover Jira account timezones; filter actual event timestamps below.
    let since = chrono::DateTime::from_timestamp_millis(start - 86_400_000)
        .ok_or("Invalid activity date.")?
        .format("%Y-%m-%d")
        .to_string();
    let issues = jira_search(c, &format!("updated >= \"{since}\" ORDER BY updated DESC"))?;
    let mut activities = Vec::new();
    for issue in issues {
        let f = &issue["fields"];
        let id = issue["id"].as_str().ok_or("Missing Jira issue ID.")?;
        if let Some(a) = jira_event(
            c,
            &issue,
            &Value::Null,
            &f["creator"],
            account,
            "created".into(),
            "created",
            "Created".into(),
            f["created"].as_str().unwrap_or_default(),
            start,
            end,
        ) {
            activities.push(a);
        }
        for event in jira_pages(
            c,
            &format!("/issue/{}/changelog", percent_encode(id)),
            "values",
        )? {
            let label = event["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| {
                    let field = v["field"].as_str().unwrap_or("field");
                    format!(
                        "Changed {field}: {}",
                        v["toString"].as_str().unwrap_or("cleared")
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            if let Some(a) = jira_event(
                c,
                &issue,
                &event,
                &event["author"],
                account,
                format!("history:{}", event["id"].as_str().unwrap_or_default()),
                "changed",
                label,
                event["created"].as_str().unwrap_or_default(),
                start,
                end,
            ) {
                activities.push(a);
            }
        }
        for comment in jira_comments(c, id)? {
            if let Some(a) = jira_event(
                c,
                &issue,
                &comment,
                &comment["author"],
                account,
                format!("comment:{}", comment["id"].as_str().unwrap_or_default()),
                "commented",
                "Commented".into(),
                comment["created"].as_str().unwrap_or_default(),
                start,
                end,
            ) {
                activities.push(a);
            }
        }
    }
    Ok(activities)
}

fn jira_worklog_query(start: i64, end: i64) -> Result<String, String> {
    // Jira interprets JQL dates in the account timezone. Widen discovery, then
    // filter each worklog's actual started timestamp to Station's local day.
    let lower = chrono::DateTime::from_timestamp_millis(start - 86_400_000)
        .ok_or("Invalid activity date.")?
        .format("%Y-%m-%d")
        .to_string();
    let upper = chrono::DateTime::from_timestamp_millis(end + 86_400_000)
        .ok_or("Invalid activity date.")?
        .format("%Y-%m-%d")
        .to_string();
    Ok(format!("worklogAuthor = currentUser() AND worklogDate >= \"{lower}\" AND worklogDate <= \"{upper}\" ORDER BY updated DESC"))
}

fn jira_worklog_duration(seconds: i64) -> String {
    let mut parts = Vec::new();
    if seconds / 3600 > 0 {
        parts.push(format!("{}h", seconds / 3600));
    }
    if seconds % 3600 / 60 > 0 {
        parts.push(format!("{}m", seconds % 3600 / 60));
    }
    if seconds % 60 > 0 {
        parts.push(format!("{}s", seconds % 60));
    }
    if parts.is_empty() {
        "0m".into()
    } else {
        parts.join(" ")
    }
}

fn jira_worklog_activity(
    c: &ConnectionRecord,
    issue: &Value,
    worklog: &Value,
    account: &str,
    start: i64,
    end: i64,
) -> Result<Option<ActivityInput>, String> {
    let author = &worklog["author"];
    if author["accountId"]
        .as_str()
        .ok_or("Jira returned a worklog without an author.")?
        != account
    {
        return Ok(None);
    }
    let started = worklog["started"]
        .as_str()
        .ok_or("Jira returned a worklog without a work date.")?;
    let occurred =
        jira_timestamp_millis(started).ok_or("Jira returned an invalid worklog date.")?;
    if occurred < start || occurred >= end {
        return Ok(None);
    }
    let id = worklog["id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("Jira returned a worklog without an ID.")?;
    let seconds = worklog["timeSpentSeconds"]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or("Jira returned an invalid worklog duration.")?;
    let key = issue["key"].as_str().ok_or("Missing Jira issue key.")?;
    let mut activity = jira_event(
        c,
        issue,
        worklog,
        author,
        account,
        format!("worklog:{id}"),
        "worklog",
        format!("Logged {} on {key}", jira_worklog_duration(seconds)),
        started,
        start,
        end,
    )
    .ok_or("Jira returned incomplete issue details for a worklog.")?;
    // Worklog IDs are site-wide. Keep identity when a worklog moves to another
    // issue or day; author identifies whose hours these are, not updateAuthor.
    activity.raw_json = serde_json::json!({"issue":issue,"event":worklog,"worklogNote":jira_document_text(&worklog["comment"]).trim()}).to_string();
    activity.external_id = format!("worklog:{id}");
    activity.target_url = Some(format!(
        "{}?focusedWorklogId={}",
        jira_url(c, key),
        percent_encode(id)
    ));
    Ok(Some(activity))
}

pub(super) fn jira_worklog_activities(
    c: &ConnectionRecord,
    start: i64,
    end: i64,
) -> Result<Vec<ActivityInput>, String> {
    let me = jira_get(c, "/myself")?;
    let account = me["accountId"]
        .as_str()
        .ok_or("Jira returned no account ID.")?;
    let issues = jira_search(c, &jira_worklog_query(start, end)?)?;
    let mut activities = Vec::new();
    for issue in issues {
        let id = issue["id"].as_str().ok_or("Missing Jira issue ID.")?;
        let worklogs = jira_pages(
            c,
            &format!(
                "/issue/{}/worklog?startedAfter={}&startedBefore={end}",
                percent_encode(id),
                start - 1
            ),
            "worklogs",
        )?;
        for worklog in worklogs {
            if let Some(activity) = jira_worklog_activity(c, &issue, &worklog, account, start, end)?
            {
                activities.push(activity);
            }
        }
    }
    Ok(activities)
}

pub(super) fn save_jira_activity_sync(
    db: &mut SqliteConnection,
    connection_id: &str,
    date: &str,
    start: i64,
    end: i64,
    activities: &[ActivityInput],
    worklogs: &Result<Vec<ActivityInput>, String>,
    fetched_at: i64,
) -> rusqlite::Result<()> {
    let transaction = db.transaction()?;
    for activity in activities {
        upsert_activity_in_db(&transaction, activity, fetched_at)?;
    }
    let warning = match worklogs {
        Ok(entries) => {
            // Only an entirely successful snapshot may remove stale worklogs.
            // This reconciles deleted entries and changes to the work date.
            transaction.execute("DELETE FROM activities WHERE provider='jira' AND connection_id=?1 AND event_type='worklog' AND occurred_at>=?2 AND occurred_at<?3", params![connection_id, start, end])?;
            for activity in entries { upsert_activity_in_db(&transaction, activity, fetched_at)?; }
            None
        }
        Err(error) => Some(format!("Jira worklogs could not be refreshed; cached logged hours were kept. Check worklog read access and that Jira time tracking is enabled. {error}")),
    };
    save_activity_sync_run_in_db(
        &transaction,
        connection_id,
        date,
        if warning.is_some() {
            "failed"
        } else {
            "success"
        },
        warning.as_deref(),
        fetched_at,
    )?;
    transaction.commit()
}

fn jira_destination(
    db: &SqliteConnection,
    task_id: &str,
    resource_id: &str,
) -> Result<(Task, Resource, ConnectionRecord), String> {
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or("Task not found.")?;
    if task.source_url.is_some()
        || !list_task_links_in_db(db, task_id)
            .map_err(db_error)?
            .is_empty()
    {
        return Err("This task already has an external resource.".into());
    }
    let resource = get_resource_by_id(db, resource_id)
        .map_err(db_error)?
        .ok_or("Jira project not found.")?;
    if resource.provider != "jira"
        || resource.kind != "jira_project"
        || task.project_id.as_deref() != Some(&resource.project_id)
    {
        return Err("Choose a Jira project connected to this task's Station project.".into());
    }
    let c = list_enabled_connections(db, &resource.project_id)
        .map_err(db_error)?
        .into_iter()
        .map(|(c, _)| c)
        .find(|c| resource.connection_id.as_deref() == Some(&c.id) && c.provider == "jira")
        .ok_or("The Jira project's connection is disabled or missing.")?;
    if !resource.external_id.starts_with(&format!(
        "{}:",
        host_from_url(&c.base_url).unwrap_or_default()
    )) {
        return Err("Jira project belongs to another site.".into());
    }
    Ok((task, resource, c))
}

#[tauri::command]
pub(super) fn list_task_jira_projects(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<Resource>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let task = get_task(&db, &task_id)
        .map_err(db_error)?
        .ok_or("Task not found.")?;
    let mut stmt=db.prepare("SELECT id,project_id,provider,kind,external_id,url,name,icon_url,connection_id FROM resources WHERE project_id=?1 AND provider='jira' AND kind='jira_project' ORDER BY name").map_err(db_error)?;
    let resources = stmt
        .query_map(params![task.project_id], row_to_resource)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(resources)
}

#[tauri::command]
pub(super) async fn list_jira_issue_types(
    app_handle: tauri::AppHandle,
    task_id: String,
    project_resource_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
        let state=app_handle.state::<AppState>();
        let (_,r,c)={let db=state.db.lock().map_err(db_error)?;jira_destination(&db,&task_id,&project_resource_id)?};
        let id=percent_encode(jira_id(&r.external_id));
        let permissions=jira_get(&c,&format!("/mypermissions?projectId={id}&permissions=CREATE_ISSUES"))?;
        if permissions["permissions"]["CREATE_ISSUES"]["havePermission"]!=true {return Err("This Jira account cannot create issues in this project. Reading remains available.".into());}
        Ok(serde_json::json!({"issueTypes":jira_pages(&c,&format!("/issue/createmeta/{id}/issuetypes"),"issueTypes")?}))
    }).await.map_err(db_error)?
}

fn jira_creation_fields(
    c: &ConnectionRecord,
    r: &Resource,
    issue_type: &str,
) -> Result<Value, String> {
    let types = jira_pages(
        c,
        &format!(
            "/issue/createmeta/{}/issuetypes",
            percent_encode(jira_id(&r.external_id))
        ),
        "issueTypes",
    )?;
    if !types
        .iter()
        .any(|t| t["id"].as_str() == Some(issue_type) && t["subtask"] != true)
    {
        return Err("Choose a supported issue type in this Jira project.".into());
    }
    let fields = jira_pages(
        c,
        &format!(
            "/issue/createmeta/{}/issuetypes/{}",
            percent_encode(jira_id(&r.external_id)),
            percent_encode(issue_type)
        ),
        "fields",
    )?;
    let unsupported = jira_unsupported_fields(&fields);
    Ok(
        serde_json::json!({"unsupportedFields":unsupported,"openUrl":format!("{}/secure/CreateIssue!default.jspa?pid={}&issuetype={}",c.base_url.trim_end_matches('/'),percent_encode(jira_id(&r.external_id)),percent_encode(issue_type))}),
    )
}

fn jira_unsupported_fields(fields: &[Value]) -> Vec<String> {
    fields
        .iter()
        .filter(|f| {
            f["required"] == true
                && f["hasDefaultValue"] != true
                && !matches!(
                    f["fieldId"].as_str().unwrap_or_default(),
                    "project" | "issuetype" | "summary" | "description" | "reporter"
                )
        })
        .map(|f| f["name"].as_str().unwrap_or("Custom field").to_string())
        .collect::<Vec<_>>()
}

#[tauri::command]
pub(super) async fn jira_create_metadata(
    app_handle: tauri::AppHandle,
    task_id: String,
    project_resource_id: String,
    issue_type_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let (_, r, c) = {
            let db = state.db.lock().map_err(db_error)?;
            jira_destination(&db, &task_id, &project_resource_id)?
        };
        jira_creation_fields(&c, &r, &issue_type_id)
    })
    .await
    .map_err(db_error)?
}

static JIRA_CREATIONS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
struct JiraCreationGuard(String);
impl JiraCreationGuard {
    fn acquire(task_id: &str) -> Result<Self, String> {
        let mut pending = JIRA_CREATIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(db_error)?;
        if !pending.insert(task_id.to_string()) {
            return Err("Jira issue creation is already running for this task.".into());
        }
        Ok(Self(task_id.to_string()))
    }
}
impl Drop for JiraCreationGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = JIRA_CREATIONS.get().unwrap().lock() {
            pending.remove(&self.0);
        }
    }
}

fn jira_persist_conversion(
    db: &mut SqliteConnection,
    task_id: &str,
    resource_id: &str,
    connection: &ConnectionRecord,
    issue: &Value,
    title: &str,
    description: &str,
) -> Result<TrelloTicketConversionResult, String> {
    jira_validate_issue(issue)?;
    let metadata = jira_metadata(connection, issue, &[]);
    let transaction = db.transaction().map_err(db_error)?;
    let (_, resource, current_connection) = jira_destination(&transaction, task_id, resource_id)?;
    if current_connection.id != connection.id
        || metadata.parent_resource.as_ref().map(|p| &p.external_id) != Some(&resource.external_id)
    {
        return Err("The Jira destination changed while the issue was being created.".into());
    }
    let id = issue["id"].as_str().ok_or("Jira returned no issue ID.")?;
    link_task_resource_in_db(
        &transaction,
        task_id.to_string(),
        "jira".into(),
        "jira_issue".into(),
        jira_identity(connection, id),
        metadata.url.clone().unwrap(),
        &metadata,
    )
    .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE tasks SET title=?1, body=?2, status=?3, updated_at=?4 WHERE id=?5",
            params![
                title.trim(),
                description,
                metadata.state,
                now_millis(),
                task_id
            ],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(TrelloTicketConversionResult {
        task: get_task(db, task_id)
            .map_err(db_error)?
            .ok_or("Task not found.")?,
        link: list_task_links_in_db(db, task_id)
            .map_err(db_error)?
            .into_iter()
            .next()
            .ok_or("Link not found.")?,
    })
}

#[tauri::command]
pub(super) async fn convert_task_to_jira_ticket(
    app_handle: tauri::AppHandle,
    task_id: String,
    project_resource_id: String,
    issue_type_id: String,
    title: String,
    description: String,
) -> Result<TrelloTicketConversionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JiraCreationGuard::acquire(&task_id)?;
        if title.trim().is_empty() { return Err("Ticket title is required.".into()); }
        let state = app_handle.state::<AppState>();
        let (_, resource, connection) = {
            let db = state.db.lock().map_err(db_error)?;
            jira_destination(&db, &task_id, &project_resource_id)?
        };
        let fields = jira_creation_fields(&connection, &resource, &issue_type_id)?;
        if !fields["unsupportedFields"].as_array().is_some_and(|v| v.is_empty()) {
            return Err("Additional required fields must be completed in Jira.".into());
        }
        let payload = serde_json::json!({ "fields": {
            "project": { "id": jira_id(&resource.external_id) },
            "issuetype": { "id": issue_type_id },
            "summary": title.trim(),
            "description": jira_document(&description),
        }});
        // A transport failure can occur after Jira commits the issue. Never retry this request.
        let created = jira_http(reqwest::Method::POST, &format!("{}/issue", jira_root(&connection)?), jira_headers(&connection)?, Some(&payload))
            .map_err(|e| format!("Jira creation did not complete: {e}. Check Jira before retrying; the issue may already exist."))?;
        let key = created["key"].as_str().ok_or("Jira creation returned no key. Check Jira before retrying.")?;
        let id = created["id"].as_str().ok_or("Jira creation returned no ID. Check Jira before retrying.")?;
        let url = jira_url(&connection, key);
        let persisted = (|| {
            let issue = jira_get(&connection, &format!("/issue/{}", percent_encode(id)))?;
            let mut db = state.db.lock().map_err(db_error)?;
            jira_persist_conversion(&mut db, &task_id, &project_resource_id, &connection, &issue, &title, &description)
        })();
        persisted.map_err(|e| format!("Jira issue was created at {url}, but Station could not link it: {e}. Open and import that issue; do not create it again."))
    }).await.map_err(db_error)?
}

#[tauri::command]
pub(super) async fn resolve_jira_tickets(
    app_handle: tauri::AppHandle,
    urls: Vec<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let connections = { let db = state.db.lock().map_err(db_error)?; list_connections_in_db(&db).map_err(db_error)? };
        let mut tickets = Vec::new(); let mut warnings = Vec::new(); let mut seen = HashSet::new();
        for url in urls {
            if !seen.insert(url.clone()) { continue; }
            let Ok(parsed) = reqwest::Url::parse(&url) else { continue; };
            let matches = connections.iter().filter(|c| c.provider == "jira" && host_from_url(&c.base_url).as_deref() == parsed.host_str()).collect::<Vec<_>>();
            if matches.len() != 1 { warnings.push(format!("Could not resolve {url}: choose a single matching Jira account, or sync its activities first.")); continue; }
            let c = matches[0];
            let Some(key) = parsed.path().strip_prefix("/browse/") else { continue; };
            match jira_get(c, &format!("/issue/{}?fields=summary,project", percent_encode(key))) {
                Ok(issue) => {
                    let canonical_url = jira_url(c, issue["key"].as_str().unwrap_or(key));
                    tickets.push(serde_json::json!({"provider":"jira","externalId":format!("jira:{}",jira_identity(c,issue["id"].as_str().unwrap_or_default())),"referenceExternalId":format!("jira:{url}"),"url":canonical_url,
                        "title":issue["fields"]["summary"],"connectionId":c.id,"projectExternalId":jira_identity(c,issue["fields"]["project"]["id"].as_str().unwrap_or_default())}));
                }
                Err(e) => warnings.push(format!("Could not resolve {url}: {e}")),
            }
        }
        Ok(serde_json::json!({"tickets":tickets,"warnings":warnings}))
    }).await.map_err(db_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn connection(host: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: format!("jira-{host}"),
            provider: "jira".into(),
            name: host.into(),
            base_url: format!("https://{host}.atlassian.net"),
            api_key: None,
            token: "read-only-token".into(),
            jira: Some(JiraConfig {
                email: "person@example.com".into(),
                token_mode: "scoped".into(),
                cloud_id: Some("cloud-123".into()),
            }),
            created_at: 1,
            updated_at: 1,
        }
    }
    fn issue() -> Value {
        json!({"id":"100","key":"APP-42","fields":{"summary":"Ship it","description":jira_document("Description"),"project":{"id":"20","key":"APP","name":"Application"},"status":{"name":"Erledigt","statusCategory":{"key":"done"}},"labels":["backend"]}})
    }
    fn database() -> SqliteConnection {
        let db = SqliteConnection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        db
    }
    fn save(db: &SqliteConnection, c: &ConnectionRecord) {
        save_connection_in_db(
            db,
            ConnectionInput {
                id: Some(c.id.clone()),
                provider: c.provider.clone(),
                name: c.name.clone(),
                base_url: c.base_url.clone(),
                api_key: None,
                token: c.token.clone(),
                jira: c.jira.clone(),
            },
        )
        .unwrap();
    }

    #[test]
    fn jira_scoped_and_unscoped_routing_and_basic_auth() {
        let mut c = connection("studio");
        assert_eq!(
            jira_root(&c).unwrap(),
            "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3"
        );
        c.jira.as_mut().unwrap().token_mode = "unscoped".into();
        assert_eq!(
            jira_root(&c).unwrap(),
            "https://studio.atlassian.net/rest/api/3"
        );
        let headers = jira_headers(&c).unwrap();
        assert_eq!(headers[0].0, "Authorization");
        assert_eq!(
            String::from_utf8(
                STANDARD
                    .decode(headers[0].1.strip_prefix("Basic ").unwrap())
                    .unwrap()
            )
            .unwrap(),
            "person@example.com:read-only-token"
        );
        assert!(validate_connection_credentials(&c).is_ok());
        c.base_url = "https://studio.atlassian.net.evil.example".into();
        assert!(jira_root(&c).is_err());
    }

    #[test]
    fn jira_migration_and_connection_config_round_trip() {
        let db = database();
        let c = connection("studio");
        save(&db, &c);
        init_database(&db).unwrap();
        let stored = get_connection(&db, &c.id).unwrap().unwrap();
        assert_eq!(stored.jira.as_ref().unwrap().email, "person@example.com");
        assert_eq!(
            stored.jira.as_ref().unwrap().cloud_id.as_deref(),
            Some("cloud-123")
        );
        assert_eq!(list_connections_in_db(&db).unwrap().len(), 1);
    }

    #[test]
    fn jira_connection_selection_is_site_exact_and_retains_account_choice() {
        let db = database();
        let p = create_project_in_db(&db, "Station".into(), None, None).unwrap();
        let a = connection("studio");
        let mut b = a.clone();
        b.id = "another-account".into();
        let other = connection("other");
        for c in [&a, &b, &other] {
            save(&db, c);
            db.execute("INSERT INTO project_connections(project_id,connection_id,enabled_at) VALUES(?1,?2,1)",params![p.id,c.id]).unwrap();
        }
        let mut parsed = ParsedInputPayload {
            kind: "jira_issue".into(),
            provider: Some("jira".into()),
            external_id: Some("studio.atlassian.net:APP-42".into()),
            url: Some(jira_url(&a, "APP-42")),
            title: "Issue".into(),
            repo_url: None,
            connection_id: None,
        };
        assert!(select_best_connection(&db, &p.id, &parsed)
            .unwrap()
            .is_none());
        parsed.connection_id = Some(b.id.clone());
        assert_eq!(
            select_best_connection(&db, &p.id, &parsed)
                .unwrap()
                .unwrap()
                .id,
            b.id
        );
        parsed.connection_id = Some(other.id.clone());
        assert!(select_best_connection(&db, &p.id, &parsed)
            .unwrap()
            .is_none());
        db.execute(
            "DELETE FROM project_connections WHERE connection_id=?1",
            params![b.id],
        )
        .unwrap();
        parsed.connection_id = Some(b.id);
        assert!(select_best_connection(&db, &p.id, &parsed)
            .unwrap()
            .is_none());
    }

    #[test]
    fn jira_pagination_loads_all_pages_and_rejects_partial_results() {
        let mut offsets = Vec::new();
        let values = jira_collect_pages("comments", |start| {
            offsets.push(start);
            Ok(if start == 0 {
                json!({"comments":[{"id":"1"},{"id":"2"}],"total":3})
            } else {
                json!({"comments":[{"id":"3"}],"total":3})
            })
        })
        .unwrap();
        assert_eq!(offsets, vec![0, 2]);
        assert_eq!(values.len(), 3);
        let error = jira_collect_pages("comments", |start| {
            if start == 0 {
                Ok(json!({"comments":[{}],"total":2}))
            } else {
                Err("Jira returned 429".into())
            }
        })
        .unwrap_err();
        assert!(error.contains("429"));
        assert!(jira_collect_pages("values", |_| Ok(json!({"values":[],"total":1}))).is_err());
    }

    #[test]
    fn jira_personal_events_use_authorship_day_bounds_and_stable_ids() {
        let c = connection("studio");
        let issue = issue();
        let author = json!({"accountId":"me","displayName":"Alex"});
        let start = jira_timestamp_millis("2026-11-20T00:00:00Z").unwrap();
        let end = start + 86_400_000;
        let make = |who: &str, at: &str| {
            jira_event(
                &c,
                &issue,
                &Value::Null,
                &author,
                who,
                "history:9".into(),
                "changed",
                "Changed status".into(),
                at,
                start,
                end,
            )
        };
        let first = make("me", "2026-11-20T00:00:00Z").unwrap();
        assert!(make("other", "2026-11-20T12:00:00Z").is_none());
        assert!(make("me", "2026-11-21T00:00:00Z").is_none());
        assert!(make("me", "2026-11-19T23:59:59Z").is_none());
        assert_eq!(
            first.external_id,
            make("me", "2026-11-20T00:00:00Z").unwrap().external_id
        );
        let db = database();
        save(&db, &c);
        upsert_activity_in_db(&db, &first, 1).unwrap();
        upsert_activity_in_db(&db, &first, 2).unwrap();
        save_activity_sync_run_in_db(
            &db,
            &c.id,
            "2026-11-20",
            "failed",
            Some("Jira returned 401"),
            3,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM activities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn jira_description_labels_comments_and_localized_status_are_readable() {
        let c = connection("studio");
        let mut issue = issue();
        issue["fields"]["description"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Docs","marks":[{"type":"link","attrs":{"href":"https://example.com"}}]}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Ship"}]}]}]}]});
        let comment = json!({"id":"9","author":{"displayName":"Alex"},"body":jira_document("Looks good"),"created":"2026-11-20T12:00:00Z"});
        let metadata = jira_metadata(&c, &issue, &[comment]);
        assert!(metadata
            .body
            .unwrap()
            .contains("[Docs](https://example.com)"));
        assert_eq!(metadata.state.as_deref(), Some("Erledigt"));
        assert_eq!(metadata.state_category.as_deref(), Some("done"));
        assert_eq!(metadata.labels[0].name, "backend");
        assert_eq!(metadata.comments[0].body, "Looks good");
        assert_eq!(
            metadata.parent_resource.unwrap().external_id,
            "studio.atlassian.net:20"
        );
    }

    #[test]
    fn jira_creation_fallback_only_blocks_required_fields_without_defaults() {
        let fields = vec![
            json!({"fieldId":"summary","required":true}),
            json!({"fieldId":"priority","name":"Priority","required":true,"hasDefaultValue":true}),
            json!({"fieldId":"customfield_100","name":"Customer","required":true}),
            json!({"fieldId":"assignee","name":"Assignee","required":false}),
        ];
        assert_eq!(jira_unsupported_fields(&fields), vec!["Customer"]);
        assert!(
            jira_document_text(&jira_document("First paragraph\nSecond paragraph"))
                .contains("Second paragraph")
        );
    }

    #[test]
    fn jira_creation_guard_prevents_duplicate_submissions_and_releases() {
        let guard = JiraCreationGuard::acquire("jira-test-task").unwrap();
        assert!(JiraCreationGuard::acquire("jira-test-task").is_err());
        drop(guard);
        assert!(JiraCreationGuard::acquire("jira-test-task").is_ok());
    }

    #[test]
    fn jira_destinations_reject_disabled_connections_and_other_station_projects() {
        let db = database();
        let c = connection("studio");
        save(&db, &c);
        let p = create_project_in_db(&db, "Station".into(), None, None).unwrap();
        let other = create_project_in_db(&db, "Other".into(), None, None).unwrap();
        let task = create_task_in_db(&db, Some(p.id.clone()), "Local".into(), "Body".into(), None)
            .unwrap();
        let resource = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: p.id.clone(),
                provider: "jira".into(),
                kind: "jira_project".into(),
                external_id: jira_identity(&c, "20"),
                url: format!("{}/projects/APP", c.base_url),
                name: "App".into(),
                icon_url: None,
                connection_id: Some(c.id.clone()),
            },
        )
        .unwrap();
        assert!(jira_destination(&db, &task.id, &resource.id)
            .unwrap_err()
            .contains("disabled"));
        db.execute(
            "INSERT INTO project_connections(project_id,connection_id,enabled_at) VALUES(?1,?2,1)",
            params![p.id, c.id],
        )
        .unwrap();
        assert!(jira_destination(&db, &task.id, &resource.id).is_ok());
        db.execute(
            "UPDATE tasks SET project_id=?1 WHERE id=?2",
            params![other.id, task.id],
        )
        .unwrap();
        assert!(jira_destination(&db, &task.id, &resource.id).is_err());
    }

    #[test]
    fn jira_identical_ids_from_different_sites_remain_separate_tasks() {
        let db = database();
        let a = connection("studio");
        let b = connection("other");
        save(&db, &a);
        save(&db, &b);
        for c in [&a, &b] {
            let task = create_task_in_db(&db, None, c.name.clone(), "".into(), None).unwrap();
            let metadata = jira_metadata(c, &issue(), &[]);
            link_task_resource_in_db(
                &db,
                task.id,
                "jira".into(),
                "jira_issue".into(),
                jira_identity(c, "100"),
                jira_url(c, "APP-42"),
                &metadata,
            )
            .unwrap();
        }
        let first = get_task_by_link(&db, "jira", "jira_issue", &jira_identity(&a, "100"))
            .unwrap()
            .unwrap();
        let second = get_task_by_link(&db, "jira", "jira_issue", &jira_identity(&b, "100"))
            .unwrap()
            .unwrap();
        assert_ne!(first.id, second.id);
    }
    fn destination_fixture() -> (SqliteConnection, ConnectionRecord, Task, Resource) {
        let db = database();
        let c = connection("studio");
        save(&db, &c);
        let p = create_project_in_db(&db, "Station".into(), None, None).unwrap();
        db.execute(
            "INSERT INTO project_connections(project_id,connection_id,enabled_at) VALUES(?1,?2,1)",
            params![p.id, c.id],
        )
        .unwrap();
        let task = create_task_in_db(
            &db,
            Some(p.id.clone()),
            "Local title".into(),
            "Local body".into(),
            None,
        )
        .unwrap();
        let resource = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: p.id,
                provider: "jira".into(),
                kind: "jira_project".into(),
                external_id: jira_identity(&c, "20"),
                url: format!("{}/projects/APP", c.base_url),
                name: "App".into(),
                icon_url: None,
                connection_id: Some(c.id.clone()),
            },
        )
        .unwrap();
        (db, c, task, resource)
    }

    #[test]
    fn jira_successful_conversion_keeps_task_identity_and_links_immutable_issue_id() {
        let (mut db, c, task, resource) = destination_fixture();
        let result = jira_persist_conversion(
            &mut db,
            &task.id,
            &resource.id,
            &c,
            &issue(),
            "Edited title",
            "Edited body",
        )
        .unwrap();
        assert_eq!(result.task.id, task.id);
        assert_eq!(result.task.title, "Edited title");
        assert_eq!(result.task.body, "Edited body");
        assert_eq!(result.link.external_id, "studio.atlassian.net:100");
        assert_eq!(result.link.connection_id.as_deref(), Some(c.id.as_str()));
        assert!(jira_destination(&db, &task.id, &resource.id).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn jira_linking_failure_leaves_original_local_task_untouched() {
        let (mut db, c, task, resource) = destination_fixture();
        db.execute(
            "DELETE FROM project_connections WHERE connection_id=?1",
            params![c.id],
        )
        .unwrap();
        assert!(jira_persist_conversion(
            &mut db,
            &task.id,
            &resource.id,
            &c,
            &issue(),
            "Edited title",
            "Edited body"
        )
        .is_err());
        let current = get_task(&db, &task.id).unwrap().unwrap();
        assert_eq!(current.title, "Local title");
        assert_eq!(current.body, "Local body");
        assert!(current.source_url.is_none());
        assert!(list_task_links_in_db(&db, &task.id).unwrap().is_empty());
    }

    #[test]
    fn jira_cache_survives_expiry_or_rate_limits_and_respects_source_selection() {
        let db = database();
        let c = connection("studio");
        save(&db, &c);
        let item = jira_assigned_issue_from_json(&c, &issue()).unwrap();
        replace_smart_inbox_provider_items(&db, &c, &[item]).unwrap();
        save_smart_inbox_provider_warning(&db, &c, "Jira returned 429").unwrap();
        let cached = list_smart_inbox_provider_items_in_db(&db, "jira").unwrap();
        assert_eq!(cached.items.len(), 1);
        assert_eq!(cached.items[0].external_id, "studio.atlassian.net:100");
        assert!(cached.warnings[0].message.contains("429"));
        update_smart_inbox_provider_sources_in_db(
            &db,
            "jira",
            vec![SmartInboxProviderSourceChange {
                connection_id: c.id.clone(),
                source_id: jira_identity(&c, "20"),
                enabled: false,
            }],
        )
        .unwrap();
        replace_smart_inbox_provider_items(
            &db,
            &c,
            &[jira_assigned_issue_from_json(&c, &issue()).unwrap()],
        )
        .unwrap();
        assert!(list_smart_inbox_provider_items_in_db(&db, "jira")
            .unwrap()
            .items
            .is_empty());
    }
    fn worklog() -> Value {
        json!({"id":"55","author":{"accountId":"me","displayName":"Alex"},"updateAuthor":{"accountId":"manager"},"started":"2026-11-20T10:00:00.000+0100","created":"2026-11-22T10:00:00.000+0100","timeSpentSeconds":7200,"comment":jira_document("Investigated the login bug")})
    }

    #[test]
    fn worklogs_use_work_date_original_author_and_jira_compact_timezone() {
        let c = connection("studio");
        let start = jira_timestamp_millis("2026-11-20T00:00:00+01:00").unwrap();
        let event =
            jira_worklog_activity(&c, &issue(), &worklog(), "me", start, start + 86_400_000)
                .unwrap()
                .unwrap();
        assert_eq!(
            event.occurred_at,
            jira_timestamp_millis("2026-11-20T09:00:00Z").unwrap()
        );
        assert_eq!(event.external_id, "worklog:55");
        assert_eq!(event.action_label, "Logged 2h on APP-42");
        assert!(event.raw_json.contains("Investigated the login bug"));
        assert!(jira_worklog_activity(
            &c,
            &issue(),
            &worklog(),
            "manager",
            start,
            start + 86_400_000
        )
        .unwrap()
        .is_none());
        assert!(jira_worklog_activity(
            &c,
            &issue(),
            &worklog(),
            "me",
            start + 86_400_000,
            start + 2 * 86_400_000
        )
        .unwrap()
        .is_none());
        let mut invalid = worklog();
        invalid["timeSpentSeconds"] = json!(-1);
        assert!(
            jira_worklog_activity(&c, &issue(), &invalid, "me", start, start + 86_400_000).is_err()
        );
        let query = jira_worklog_query(start, start + 86_400_000).unwrap();
        assert!(query.contains("worklogDate"));
        assert!(query.contains("worklogAuthor = currentUser()"));
        assert!(!query.contains("updated >="));
    }

    #[test]
    fn worklog_sync_replaces_edits_removes_deletions_and_preserves_other_activities() {
        let mut db = database();
        let c = connection("studio");
        save(&db, &c);
        let start = jira_timestamp_millis("2026-11-20T00:00:00Z").unwrap();
        let end = start + 86_400_000;
        let base = jira_event(
            &c,
            &issue(),
            &Value::Null,
            &json!({"accountId":"me"}),
            "me",
            "created".into(),
            "created",
            "Created".into(),
            "2026-11-20T12:00:00Z",
            start,
            end,
        )
        .unwrap();
        let first = jira_worklog_activity(&c, &issue(), &worklog(), "me", start, end)
            .unwrap()
            .unwrap();
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-20",
            start,
            end,
            &[base],
            &Ok(vec![first.clone()]),
            1,
        )
        .unwrap();
        let mut edit = worklog();
        edit["timeSpentSeconds"] = json!(5400);
        let edited = jira_worklog_activity(&c, &issue(), &edit, "me", start, end)
            .unwrap()
            .unwrap();
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-20",
            start,
            end,
            &[],
            &Ok(vec![edited]),
            2,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM activities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let label: String = db
            .query_row(
                "SELECT action_label FROM activities WHERE event_type='worklog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(label, "Logged 1h 30m on APP-42");
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-20",
            start,
            end,
            &[],
            &Err("403 missing worklog read scope".into()),
            3,
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM activities WHERE event_type='worklog'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let warning:String=db.query_row("SELECT warning FROM activity_sync_runs WHERE connection_id=?1 AND date='2026-11-20'",params![c.id],|r|r.get(0)).unwrap();
        assert!(warning.contains("cached logged hours were kept"));
        let other = connection("other");
        save(&db, &other);
        let other_event = jira_worklog_activity(&other, &issue(), &worklog(), "me", start, end)
            .unwrap()
            .unwrap();
        upsert_activity_in_db(&db, &other_event, 4).unwrap();
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-20",
            start,
            end,
            &[],
            &Ok(vec![]),
            5,
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM activities WHERE event_type='worklog'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM activities WHERE event_type='created'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn worklog_moved_to_another_day_or_issue_keeps_one_cached_entry() {
        let mut db = database();
        let c = connection("studio");
        save(&db, &c);
        let start = jira_timestamp_millis("2026-11-20T00:00:00Z").unwrap();
        let end = start + 86_400_000;
        let first = jira_worklog_activity(&c, &issue(), &worklog(), "me", start, end)
            .unwrap()
            .unwrap();
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-20",
            start,
            end,
            &[],
            &Ok(vec![first]),
            1,
        )
        .unwrap();
        let mut moved = worklog();
        moved["started"] = json!("2026-11-21T12:00:00.000+0000");
        let mut new_issue = issue();
        new_issue["id"] = json!("200");
        new_issue["key"] = json!("APP-99");
        let next = jira_worklog_activity(&c, &new_issue, &moved, "me", end, end + 86_400_000)
            .unwrap()
            .unwrap();
        save_jira_activity_sync(
            &mut db,
            &c.id,
            "2026-11-21",
            end,
            end + 86_400_000,
            &[],
            &Ok(vec![next]),
            2,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM activities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM activities WHERE occurred_at<?1",
                params![end],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let url: String = db
            .query_row("SELECT target_url FROM activities", [], |r| r.get(0))
            .unwrap();
        assert!(url.contains("APP-99"));
    }
}
