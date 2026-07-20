use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rand::{distributions::Alphanumeric, Rng};
use reqwest::{
    blocking::{Client, RequestBuilder},
    header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED},
    StatusCode,
};
use rrule::{RRuleSet, Tz as RRuleTz};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    net::TcpListener,
    time::{Duration, Instant},
};

const SQLITE_CREDENTIAL_MIGRATION: &str = "credentials_in_sqlite_v1";
const MAX_ICAL_FEED_BYTES: usize = 20 * 1024 * 1024;
const GOOGLE_API_URL: &str = "https://www.googleapis.com/calendar/v3";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_READONLY_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_OAUTH_CLIENT_ID: &str =
    "554244875571-4oenqf91i7imjq7o89rfhpgshjpb0unf.apps.googleusercontent.com";
const GOOGLE_OAUTH_CLIENT_SECRET: &str = "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";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccount {
    pub id: String,
    pub provider: String,
    pub auth_type: String,
    pub name: String,
    pub server_url: String,
    pub username: Option<String>,
    pub has_credential: bool,
    pub calendar_enabled: bool,
    pub calendars: Vec<CalendarCollection>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCollection {
    pub id: String,
    pub account_id: String,
    pub remote_id: String,
    pub href: String,
    pub name: String,
    pub color: String,
    pub enabled: bool,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub collection_id: String,
    pub calendar_name: String,
    pub calendar_color: String,
    pub uid: String,
    pub recurrence_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: i64,
    pub end_at: i64,
    pub all_day: bool,
    pub status: Option<String>,
    pub attendee_status: Option<String>,
    pub organizer: Option<String>,
    pub join_url: Option<String>,
    pub event_url: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncRun {
    pub collection_id: String,
    pub calendar_name: String,
    pub account_id: String,
    pub account_name: String,
    pub date: String,
    pub status: String,
    pub warning: Option<String>,
    pub synced_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarResult {
    pub events: Vec<CalendarEvent>,
    pub sync_runs: Vec<CalendarSyncRun>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalDavAccountInput {
    pub id: Option<String>,
    pub name: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSubscriptionInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSelectionInput {
    pub id: String,
    pub enabled: bool,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarServiceInput {
    pub account_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
struct AccountRecord {
    id: String,
    provider: String,
    auth_type: String,
    name: String,
    server_url: String,
    username: Option<String>,
    calendar_enabled: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct RemoteCollection {
    href: String,
    name: String,
    color: String,
    enabled_by_default: bool,
    sync_token: Option<String>,
    ctag: Option<String>,
}

#[derive(Debug, Clone)]
enum Auth {
    Basic(String, String),
}

#[derive(Debug, Clone)]
struct ParsedEvent {
    uid: String,
    recurrence_id: Option<String>,
    title: String,
    description: Option<String>,
    location: Option<String>,
    start_at: i64,
    end_at: i64,
    all_day: bool,
    status: Option<String>,
    attendee_status: Option<String>,
    organizer: Option<String>,
    join_url: Option<String>,
    event_url: Option<String>,
    timezone: Option<String>,
    recurrence_id_at: Option<i64>,
    recurrence_set: Option<String>,
}

pub fn init_database(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS calendar_accounts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            name TEXT NOT NULL,
            server_url TEXT NOT NULL,
            username TEXT,
            calendar_enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_collections (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
            remote_id TEXT NOT NULL,
            href TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#64748b',
            enabled INTEGER NOT NULL DEFAULT 1,
            sync_token TEXT,
            ctag TEXT,
            last_synced_at INTEGER,
            UNIQUE(account_id, href)
        );
        CREATE TABLE IF NOT EXISTS calendar_credentials (
            account_id TEXT PRIMARY KEY REFERENCES calendar_accounts(id) ON DELETE CASCADE,
            secret TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_migrations (
            key TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_resources (
            collection_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
            href TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            raw_ical TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY(collection_id, href)
        );
        CREATE TABLE IF NOT EXISTS calendar_events (
            id TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
            resource_href TEXT NOT NULL,
            uid TEXT NOT NULL,
            recurrence_id TEXT,
            title TEXT NOT NULL,
            description TEXT,
            location TEXT,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            all_day INTEGER NOT NULL,
            status TEXT,
            attendee_status TEXT,
            organizer TEXT,
            join_url TEXT,
            event_url TEXT,
            timezone TEXT,
            fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calendar_sync_ranges (
            collection_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            synced_at INTEGER NOT NULL,
            PRIMARY KEY(collection_id, date)
        );
        CREATE TABLE IF NOT EXISTS calendar_sync_runs (
            collection_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            status TEXT NOT NULL,
            warning TEXT,
            synced_at INTEGER NOT NULL,
            PRIMARY KEY(collection_id, date)
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_events_range
            ON calendar_events(start_at, end_at);
        ",
    )?;
    let resource_columns = db
        .prepare("PRAGMA table_info(calendar_resources)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !resource_columns
        .iter()
        .any(|column| column == "last_modified")
    {
        db.execute(
            "ALTER TABLE calendar_resources ADD COLUMN last_modified TEXT",
            [],
        )?;
    }
    let account_columns = db
        .prepare("PRAGMA table_info(calendar_accounts)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !account_columns
        .iter()
        .any(|column| column == "calendar_enabled")
    {
        db.execute(
            "ALTER TABLE calendar_accounts ADD COLUMN calendar_enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    let sqlite_credentials_migrated: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM calendar_migrations WHERE key=?1)",
        params![SQLITE_CREDENTIAL_MIGRATION],
        |row| row.get(0),
    )?;
    if !sqlite_credentials_migrated {
        db.execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM calendar_sync_runs;
             DELETE FROM calendar_sync_ranges;
             DELETE FROM calendar_events;
             DELETE FROM calendar_resources;
             DELETE FROM calendar_collections;
             DELETE FROM calendar_credentials;
             DELETE FROM calendar_accounts;
             INSERT INTO calendar_migrations (key,applied_at) VALUES ('credentials_in_sqlite_v1',0);
             COMMIT;",
        )?;
    }
    Ok(())
}

pub fn list_accounts(db: &Connection) -> Result<Vec<CalendarAccount>, String> {
    let records = list_account_records(db)?;
    records
        .into_iter()
        .map(|record| account_from_record(db, record))
        .collect()
}

pub fn connect_google_account(
    db: &Connection,
    now: i64,
    expected_account_id: Option<&str>,
    open_url: impl FnOnce(&str) -> Result<(), String>,
    is_cancelled: impl Fn() -> bool,
) -> Result<CalendarAccount, String> {
    if is_cancelled() {
        return Err("Google sign-in was cancelled.".to_string());
    }
    let expected_account_name = expected_account_id
        .map(|account_id| account_record(db, account_id))
        .transpose()?
        .map(|account| {
            if account.provider != "google" {
                return Err("Only Google accounts can be reconnected with Google.".to_string());
            }
            Ok(account.name)
        })
        .transpose()?;
    let client_id = GOOGLE_OAUTH_CLIENT_ID;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not start the Google sign-in callback: {error}"))?;
    let port = listener.local_addr().map_err(to_string)?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/google/callback");
    let state = random_token(40);
    let verifier = random_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut auth_url = reqwest::Url::parse(GOOGLE_AUTH_URL).map_err(to_string)?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            &format!("openid email {GOOGLE_CALENDAR_READONLY_SCOPE}"),
        )
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    open_url(auth_url.as_str())?;
    listener.set_nonblocking(true).map_err(to_string)?;
    let started = Instant::now();
    let (mut stream, _) = loop {
        if is_cancelled() {
            return Err("Google sign-in was cancelled.".to_string());
        }
        match listener.accept() {
            Ok(connection) => break connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed() >= Duration::from_secs(180) {
                    return Err("Google sign-in timed out. Please try again.".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("Google sign-in callback failed: {error}")),
        }
    };
    if is_cancelled() {
        return Err("Google sign-in was cancelled.".to_string());
    }
    let mut buffer = [0_u8; 8192];
    let length = std::io::Read::read(&mut stream, &mut buffer).map_err(to_string)?;
    let request = String::from_utf8_lossy(&buffer[..length]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Google sign-in returned an invalid callback.".to_string())?;
    let callback = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Google sign-in returned an invalid callback.".to_string())?;
    let params = callback
        .query_pairs()
        .into_owned()
        .collect::<HashMap<_, _>>();
    let response_body = google_oauth_callback_page(params.get("error").is_some());
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body
    );
    let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
    if params.get("state") != Some(&state) {
        return Err("Google sign-in state validation failed. Please try again.".to_string());
    }
    if let Some(error) = params.get("error") {
        return Err(if error == "access_denied" {
            "Google sign-in was cancelled.".to_string()
        } else {
            format!("Google sign-in failed: {error}")
        });
    }
    let code = params
        .get("code")
        .ok_or_else(|| "Google sign-in did not return an authorization code.".to_string())?;
    let token_response = http_client()?
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", GOOGLE_OAUTH_CLIENT_SECRET),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .map_err(|_| "Could not finish Google sign-in.".to_string())?;
    if !token_response.status().is_success() {
        let status = token_response.status();
        let error = token_response.json::<Value>().unwrap_or(Value::Null);
        return Err(google_oauth_error_message(
            status,
            &error,
            &[code.as_str(), verifier.as_str()],
        ));
    }
    let token: Value = token_response
        .json()
        .map_err(|_| "Google returned an invalid token response.".to_string())?;
    if token
        .get("scope")
        .and_then(Value::as_str)
        .is_some_and(|scopes| {
            !scopes
                .split_whitespace()
                .any(|scope| scope == GOOGLE_CALENDAR_READONLY_SCOPE)
        })
    {
        return Err(
            "Google Calendar read access was not granted. Reconnect and allow Calendar access."
                .to_string(),
        );
    }
    let access_token = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Google did not return an access token.".to_string())?;
    let user: Value = http_client()?
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(|_| "Could not read the connected Google account.".to_string())?
        .json()
        .map_err(to_string)?;
    let email = user
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Google did not return the account email.".to_string())?;
    let id = format!(
        "calendar_google_{}",
        stable_hash(&email.to_ascii_lowercase())
    );
    if expected_account_id.is_some_and(|expected_id| expected_id != id) {
        return Err(format!(
            "You signed in as {email}. Sign in as {} to reconnect this account.",
            expected_account_name
                .as_deref()
                .unwrap_or("the existing Google account")
        ));
    }
    let refresh_token = token.get("refresh_token").and_then(Value::as_str).map(str::to_string)
        .or_else(|| get_secret(db, &id).ok())
        .ok_or_else(|| "Google did not return offline access. Remove the app from your Google account and try again.".to_string())?;
    let calendars = google_calendar_list(access_token)?;
    if calendars.is_empty() {
        return Err("This Google account has no calendars.".to_string());
    }
    let transaction = db.unchecked_transaction().map_err(to_string)?;
    transaction.execute(
        "INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,calendar_enabled,created_at,updated_at)
         VALUES (?1,'google','oauth',?2,?3,?2,1,?4,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,calendar_enabled=1,updated_at=excluded.updated_at",
        params![id,email,GOOGLE_API_URL,now],
    ).map_err(to_string)?;
    set_secret(&transaction, &id, &refresh_token, now)?;
    store_discovered_collections(&transaction, &id, calendars, now)?;
    transaction.commit().map_err(to_string)?;
    get_account(db, &id)?.ok_or_else(|| "Google account was not saved.".to_string())
}

fn google_oauth_callback_page(cancelled: bool) -> String {
    let (title, message) = if cancelled {
        (
            "Google sign-in cancelled",
            "Google sign-in was cancelled. You can close this tab.",
        )
    } else {
        (
            "Google account connected",
            "Google authorization was received. Return to Station.",
        )
    };
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title></head><body><main><h1>{title}</h1><p>{message}</p></main><script>history.replaceState(null,"","/oauth/google/complete");window.close();</script></body></html>"#
    )
}

pub fn update_calendar_service(
    db: &Connection,
    input: CalendarServiceInput,
    now: i64,
) -> Result<CalendarAccount, String> {
    let account = account_record(db, &input.account_id)?;
    if account.provider != "google" {
        return Err("Only Google accounts have optional Calendar access.".to_string());
    }
    db.execute(
        "UPDATE calendar_accounts SET calendar_enabled=?1,updated_at=?2 WHERE id=?3",
        params![input.enabled, now, input.account_id],
    )
    .map_err(to_string)?;
    if input.enabled {
        let token = google_access_token(db, &account)?;
        store_google_collections(db, &account.id, &token, now)?;
    }
    get_account(db, &account.id)?.ok_or_else(|| "Calendar account not found.".to_string())
}

pub fn save_caldav_account(
    db: &Connection,
    input: CalDavAccountInput,
    now: i64,
    new_id: impl FnOnce() -> String,
) -> Result<CalendarAccount, String> {
    let name = input.name.trim();
    let username = input.username.trim();
    let password = input.password.trim();
    let server_url = normalize_server_url(&input.server_url)?;
    if name.is_empty() || username.is_empty() || password.is_empty() {
        return Err("Calendar name, username, and password are required.".to_string());
    }
    let id = input.id.unwrap_or_else(new_id);
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM calendar_accounts WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(to_string)?;
    let previous = if exists {
        Some(account_record(db, &id)?)
    } else {
        None
    };
    let previous_secret = previous
        .as_ref()
        .and_then(|record| get_secret(db, &record.id).ok());
    if exists {
        db.execute(
            "UPDATE calendar_accounts SET name=?1, server_url=?2, username=?3, updated_at=?4 WHERE id=?5",
            params![name, server_url, username, now, id],
        )
        .map_err(to_string)?;
    } else {
        db.execute(
            "INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at)
             VALUES (?1,'caldav','basic',?2,?3,?4,?5,?5)",
            params![id, name, server_url, username, now],
        )
        .map_err(to_string)?;
    }
    set_secret(db, &id, password, now)?;
    if let Err(error) = refresh_collections(db, &id, now) {
        if !exists {
            let _ = db.execute("DELETE FROM calendar_accounts WHERE id=?1", params![id]);
        } else if let Some(previous) = previous {
            let _ = db.execute(
                "UPDATE calendar_accounts SET name=?1,server_url=?2,username=?3,updated_at=?4 WHERE id=?5",
                params![previous.name,previous.server_url,previous.username,previous.updated_at,previous.id],
            );
            if let Some(previous_secret) = previous_secret {
                let _ = set_secret(db, &id, &previous_secret, now);
            } else {
                let _ = db.execute(
                    "DELETE FROM calendar_credentials WHERE account_id=?1",
                    params![id],
                );
            }
        }
        return Err(error);
    }
    get_account(db, &id)?.ok_or_else(|| "Calendar account was not saved.".to_string())
}

pub fn save_calendar_subscription(
    db: &Connection,
    input: CalendarSubscriptionInput,
    now: i64,
) -> Result<CalendarAccount, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Enter a calendar name.".to_string());
    }
    let id = input.id.unwrap_or_else(|| format!("calendar_ical_{now}"));
    let existing = account_record(db, &id).ok();
    if existing
        .as_ref()
        .is_some_and(|account| account.provider != "ical")
    {
        return Err("This account is not an iCal subscription.".to_string());
    }
    let url = if input.url.trim().is_empty() {
        get_secret(db, &id).map_err(|_| "Enter the secret iCal URL.".to_string())?
    } else {
        normalize_subscription_url(&input.url)?
    };
    validate_ical_feed(&url)?;
    let host = redacted_source_host(&url)?;
    let color = normalize_color(input.color.as_deref().unwrap_or("#64748b"));
    db.execute(
        "INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at)
         VALUES (?1,'ical','subscription',?2,?3,NULL,?4,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,server_url=excluded.server_url,updated_at=excluded.updated_at",
        params![id, name, host, now],
    ).map_err(to_string)?;
    let collection_id = format!("calendar_collection_{}", stable_hash(&id));
    db.execute(
        "INSERT INTO calendar_collections (id,account_id,remote_id,href,name,color,enabled) VALUES (?1,?2,'subscription','subscription-feed',?3,?4,1)
         ON CONFLICT(account_id,href) DO UPDATE SET name=excluded.name,color=excluded.color",
        params![collection_id, id, name, color],
    ).map_err(to_string)?;
    set_secret(db, &id, &url, now)?;
    get_account(db, &id)?.ok_or_else(|| "Calendar subscription was not saved.".to_string())
}

pub fn refresh_collections(
    db: &Connection,
    account_id: &str,
    now: i64,
) -> Result<CalendarAccount, String> {
    let account = account_record(db, account_id)?;
    if account.provider == "ical" {
        validate_ical_feed(&get_secret(db, account_id)?)?;
        return get_account(db, account_id)?
            .ok_or_else(|| "Calendar account not found.".to_string());
    }
    if account.provider == "google" {
        let token = google_access_token(db, &account)?;
        store_google_collections(db, &account.id, &token, now)?;
        return get_account(db, account_id)?
            .ok_or_else(|| "Calendar account not found.".to_string());
    }
    let auth = auth_for_account(db, &account)?;
    discover_and_store(db, &account, auth, now)?;
    get_account(db, account_id)?.ok_or_else(|| "Calendar account not found.".to_string())
}

pub fn update_collections(
    db: &Connection,
    inputs: Vec<CalendarSelectionInput>,
) -> Result<(), String> {
    for input in inputs {
        let color = input.color.as_deref().map(normalize_color);
        db.execute(
            "UPDATE calendar_collections SET enabled=CASE WHEN account_id IN (SELECT id FROM calendar_accounts WHERE provider='google') THEN ?1 ELSE 1 END, color=COALESCE(?2,color) WHERE id=?3",
            params![input.enabled, color, input.id],
        )
        .map_err(to_string)?;
    }
    Ok(())
}

pub fn test_account(db: &Connection, account_id: &str) -> Result<String, String> {
    let account = account_record(db, account_id)?;
    if account.provider == "ical" {
        validate_ical_feed(&get_secret(db, account_id)?)?;
        return Ok("Connected. The iCal feed is valid.".to_string());
    }
    if account.provider == "google" {
        let token = google_access_token(db, &account)?;
        let calendars = google_calendar_list(&token)?;
        return Ok(format!(
            "Connected. Found {} calendar{}.",
            calendars.len(),
            if calendars.len() == 1 { "" } else { "s" }
        ));
    }
    let auth = auth_for_account(db, &account)?;
    let calendars = discover_collections(&account.server_url, &auth)?;
    Ok(format!(
        "Connected. Found {} calendar{}.",
        calendars.len(),
        if calendars.len() == 1 { "" } else { "s" }
    ))
}

pub fn delete_account(db: &Connection, account_id: &str) -> Result<(), String> {
    if account_record(db, account_id)
        .ok()
        .is_some_and(|account| account.provider == "google")
    {
        if let Ok(token) = get_secret(db, account_id) {
            let _ = http_client().and_then(|client| {
                client
                    .post(GOOGLE_REVOKE_URL)
                    .form(&[("token", token)])
                    .send()
                    .map(|_| ())
                    .map_err(to_string)
            });
        }
    }
    db.execute(
        "DELETE FROM calendar_accounts WHERE id=?1",
        params![account_id],
    )
    .map_err(to_string)?;
    Ok(())
}

pub fn list_events(
    db: &Connection,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<CalendarResult, String> {
    let mut statement = db.prepare(
        "SELECT e.id,a.id,a.name,c.id,c.name,c.color,e.uid,e.recurrence_id,e.title,e.description,e.location,
                e.start_at,e.end_at,e.all_day,e.status,e.attendee_status,e.organizer,e.join_url,e.event_url,e.timezone
         FROM calendar_events e
         JOIN calendar_collections c ON c.id=e.collection_id
         JOIN calendar_accounts a ON a.id=c.account_id
         WHERE a.calendar_enabled=1 AND c.enabled=1 AND e.start_at < ?2 AND e.end_at > ?1 AND lower(COALESCE(e.status,'')) != 'cancelled'
         ORDER BY e.all_day DESC,e.start_at ASC,e.id ASC"
    ).map_err(to_string)?;
    let events = statement
        .query_map(params![start_at, end_at], |row| {
            Ok(CalendarEvent {
                id: row.get(0)?,
                account_id: row.get(1)?,
                account_name: row.get(2)?,
                collection_id: row.get(3)?,
                calendar_name: row.get(4)?,
                calendar_color: row.get(5)?,
                uid: row.get(6)?,
                recurrence_id: row.get(7)?,
                title: row.get(8)?,
                description: row.get(9)?,
                location: row.get(10)?,
                start_at: row.get(11)?,
                end_at: row.get(12)?,
                all_day: row.get::<_, i64>(13)? != 0,
                status: row.get(14)?,
                attendee_status: row.get(15)?,
                organizer: row.get(16)?,
                join_url: row.get(17)?,
                event_url: row.get(18)?,
                timezone: row.get(19)?,
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    let mut sync_statement = db.prepare(
        "SELECT r.collection_id,c.name,a.id,a.name,r.date,r.status,r.warning,r.synced_at
         FROM calendar_sync_runs r JOIN calendar_collections c ON c.id=r.collection_id
         JOIN calendar_accounts a ON a.id=c.account_id WHERE r.date=?1 AND a.calendar_enabled=1 AND c.enabled=1 ORDER BY a.name,c.name"
    ).map_err(to_string)?;
    let sync_runs = sync_statement
        .query_map(params![date], |row| {
            Ok(CalendarSyncRun {
                collection_id: row.get(0)?,
                calendar_name: row.get(1)?,
                account_id: row.get(2)?,
                account_name: row.get(3)?,
                date: row.get(4)?,
                status: row.get(5)?,
                warning: row.get(6)?,
                synced_at: row.get(7)?,
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(CalendarResult { events, sync_runs })
}

pub fn sync_events(
    db: &Connection,
    date: &str,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> Result<CalendarResult, String> {
    let collections = enabled_collection_records(db)?;
    for (account, collection) in collections {
        let result = if account.provider == "ical" {
            sync_subscription_day(db, &account, &collection, date, start_at, end_at, now)
        } else if account.provider == "google" {
            google_access_token(db, &account).and_then(|token| {
                sync_google_day(
                    db,
                    &account,
                    &collection,
                    &token,
                    date,
                    start_at,
                    end_at,
                    now,
                )
            })
        } else {
            auth_for_account(db, &account).and_then(|auth| {
                sync_collection_day(
                    db,
                    &collection,
                    &auth,
                    account.username.as_deref(),
                    date,
                    start_at,
                    end_at,
                    now,
                )
            })
        };
        let (status, warning) = match result {
            Ok(()) => ("success", None),
            Err(error) => ("failed", Some(error)),
        };
        db.execute(
            "INSERT INTO calendar_sync_runs (collection_id,date,status,warning,synced_at) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(collection_id,date) DO UPDATE SET status=excluded.status,warning=excluded.warning,synced_at=excluded.synced_at",
            params![collection.id,date,status,warning,now],
        ).map_err(to_string)?;
    }
    list_events(db, date, start_at, end_at)
}

fn sync_subscription_day(
    db: &Connection,
    account: &AccountRecord,
    collection: &CollectionRecord,
    date: &str,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> Result<(), String> {
    let url = get_secret(db, &account.id)?;
    let cached: Option<(String, Option<String>, Option<String>)> = db.query_row(
        "SELECT raw_ical,etag,last_modified FROM calendar_resources WHERE collection_id=?1 AND href='subscription-feed'",
        params![collection.id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(to_string)?;
    let mut request = http_client()?.get(&url);
    if let Some((_, etag, last_modified)) = cached.as_ref() {
        if let Some(etag) = etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(last_modified) = last_modified {
            request = request.header(IF_MODIFIED_SINCE, last_modified);
        }
    }
    let response = request
        .send()
        .map_err(|_| "Could not download the calendar feed.".to_string())?;
    let (raw, etag, last_modified) = if response.status() == StatusCode::NOT_MODIFIED {
        cached.ok_or_else(|| "The calendar feed returned no data.".to_string())?
    } else {
        let response = response
            .error_for_status()
            .map_err(|_| "Could not download the calendar feed.".to_string())?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let last_modified = response
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let mut bytes = Vec::new();
        response
            .take((MAX_ICAL_FEED_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read the calendar feed.".to_string())?;
        if bytes.len() > MAX_ICAL_FEED_BYTES {
            return Err("The calendar feed is too large.".to_string());
        }
        let raw = String::from_utf8(bytes)
            .map_err(|_| "The calendar feed is not valid UTF-8.".to_string())?;
        if !raw.to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
            return Err("The URL did not return a valid iCal calendar.".to_string());
        }
        (raw, etag, last_modified)
    };
    let events = expand_ical_events(&raw, None, start_at, end_at)?;
    db.execute(
        "DELETE FROM calendar_events WHERE collection_id=?1 AND start_at < ?3 AND end_at > ?2",
        params![collection.id, start_at, end_at],
    )
    .map_err(to_string)?;
    for event in events {
        if event
            .status
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("cancelled"))
            || event.start_at >= end_at
            || event.end_at <= start_at
        {
            continue;
        }
        let recurrence = event
            .recurrence_id
            .clone()
            .unwrap_or_else(|| event.start_at.to_string());
        let id = format!("calendar:{}:{}:{}", collection.id, event.uid, recurrence);
        db.execute(
            "INSERT INTO calendar_events (id,collection_id,resource_href,uid,recurrence_id,title,description,location,start_at,end_at,all_day,status,attendee_status,organizer,join_url,event_url,timezone,fetched_at)
             VALUES (?1,?2,'subscription-feed',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,location=excluded.location,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,status=excluded.status,attendee_status=excluded.attendee_status,organizer=excluded.organizer,join_url=excluded.join_url,event_url=excluded.event_url,timezone=excluded.timezone,fetched_at=excluded.fetched_at",
            params![id,collection.id,event.uid,event.recurrence_id,event.title,event.description,event.location,event.start_at,event.end_at,event.all_day,event.status,event.attendee_status,event.organizer,event.join_url,event.event_url,event.timezone,now]
        ).map_err(to_string)?;
    }
    db.execute(
        "INSERT INTO calendar_resources (collection_id,href,etag,last_modified,raw_ical,fetched_at) VALUES (?1,'subscription-feed',?2,?3,?4,?5)
         ON CONFLICT(collection_id,href) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,raw_ical=excluded.raw_ical,fetched_at=excluded.fetched_at",
        params![collection.id,etag,last_modified,raw,now],
    ).map_err(to_string)?;
    db.execute("INSERT INTO calendar_sync_ranges (collection_id,date,synced_at) VALUES (?1,?2,?3) ON CONFLICT(collection_id,date) DO UPDATE SET synced_at=excluded.synced_at", params![collection.id,date,now]).map_err(to_string)?;
    db.execute(
        "UPDATE calendar_collections SET last_synced_at=?1 WHERE id=?2",
        params![now, collection.id],
    )
    .map_err(to_string)?;
    Ok(())
}

fn sync_collection_day(
    db: &Connection,
    collection: &CollectionRecord,
    auth: &Auth,
    account_username: Option<&str>,
    date: &str,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> Result<(), String> {
    if let Some(token) = collection.sync_token.as_deref() {
        match sync_token_report(&collection.href, auth, token) {
            Ok(Some(next)) => {
                db.execute(
                    "UPDATE calendar_collections SET sync_token=?1 WHERE id=?2",
                    params![next, collection.id],
                )
                .map_err(to_string)?;
            }
            Ok(None) => {}
            Err(_) => {
                db.execute(
                    "UPDATE calendar_collections SET sync_token=NULL WHERE id=?1",
                    params![collection.id],
                )
                .map_err(to_string)?;
            }
        }
    }
    let resources = query_calendar_day(&collection.href, auth, start_at, end_at)?;
    db.execute(
        "DELETE FROM calendar_events WHERE collection_id=?1 AND start_at < ?3 AND end_at > ?2",
        params![collection.id, start_at, end_at],
    )
    .map_err(to_string)?;
    for (href, etag, raw) in resources {
        db.execute(
            "INSERT INTO calendar_resources (collection_id,href,etag,raw_ical,fetched_at) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(collection_id,href) DO UPDATE SET etag=excluded.etag,raw_ical=excluded.raw_ical,fetched_at=excluded.fetched_at",
            params![collection.id,href,etag,raw,now],
        ).map_err(to_string)?;
        for event in parse_ical_events(&raw, account_username) {
            if event
                .status
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("cancelled"))
                || event.start_at >= end_at
                || event.end_at <= start_at
            {
                continue;
            }
            let recurrence = event
                .recurrence_id
                .clone()
                .unwrap_or_else(|| event.start_at.to_string());
            let id = format!("calendar:{}:{}:{}", collection.id, event.uid, recurrence);
            db.execute(
                "INSERT INTO calendar_events (id,collection_id,resource_href,uid,recurrence_id,title,description,location,start_at,end_at,all_day,status,attendee_status,organizer,join_url,event_url,timezone,fetched_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,location=excluded.location,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,status=excluded.status,attendee_status=excluded.attendee_status,organizer=excluded.organizer,join_url=excluded.join_url,event_url=excluded.event_url,timezone=excluded.timezone,fetched_at=excluded.fetched_at",
                params![id,collection.id,href,event.uid,event.recurrence_id,event.title,event.description,event.location,event.start_at,event.end_at,event.all_day,event.status,event.attendee_status,event.organizer,event.join_url,event.event_url,event.timezone,now],
            ).map_err(to_string)?;
        }
    }
    db.execute("INSERT INTO calendar_sync_ranges (collection_id,date,synced_at) VALUES (?1,?2,?3) ON CONFLICT(collection_id,date) DO UPDATE SET synced_at=excluded.synced_at", params![collection.id,date,now]).map_err(to_string)?;
    db.execute(
        "UPDATE calendar_collections SET last_synced_at=?1 WHERE id=?2",
        params![now, collection.id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[derive(Clone)]
struct CollectionRecord {
    id: String,
    href: String,
    sync_token: Option<String>,
}

fn enabled_collection_records(
    db: &Connection,
) -> Result<Vec<(AccountRecord, CollectionRecord)>, String> {
    let mut statement = db.prepare(
        "SELECT a.id,a.provider,a.auth_type,a.name,a.server_url,a.username,a.calendar_enabled,a.created_at,a.updated_at,c.id,c.href,c.sync_token
         FROM calendar_collections c JOIN calendar_accounts a ON a.id=c.account_id WHERE a.calendar_enabled=1 AND (a.provider != 'google' OR c.enabled=1) ORDER BY a.name,c.name"
    ).map_err(to_string)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                AccountRecord {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    auth_type: row.get(2)?,
                    name: row.get(3)?,
                    server_url: row.get(4)?,
                    username: row.get(5)?,
                    calendar_enabled: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                },
                CollectionRecord {
                    id: row.get(9)?,
                    href: row.get(10)?,
                    sync_token: row.get(11)?,
                },
            ))
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(rows)
}

fn discover_and_store(
    db: &Connection,
    account: &AccountRecord,
    auth: Auth,
    now: i64,
) -> Result<(), String> {
    let calendars = discover_collections(&account.server_url, &auth)?;
    store_discovered_collections(db, &account.id, calendars, now)
}

fn store_discovered_collections(
    db: &Connection,
    account_id: &str,
    calendars: Vec<RemoteCollection>,
    now: i64,
) -> Result<(), String> {
    if calendars.is_empty() {
        return Err("The server did not expose any VEVENT calendars.".to_string());
    }
    for calendar in calendars {
        let existing: Option<(String, i64, String)> = db
            .query_row(
                "SELECT id,enabled,color FROM calendar_collections WHERE account_id=?1 AND href=?2",
                params![account_id, calendar.href],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(to_string)?;
        let (id, enabled, color) = existing.unwrap_or_else(|| {
            (
                format!(
                    "calendar_collection_{}_{}",
                    now,
                    stable_hash(&calendar.href)
                ),
                i64::from(calendar.enabled_by_default),
                calendar.color.clone(),
            )
        });
        db.execute(
            "INSERT INTO calendar_collections (id,account_id,remote_id,href,name,color,enabled,sync_token,ctag) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(account_id,href) DO UPDATE SET remote_id=excluded.remote_id,name=excluded.name,sync_token=COALESCE(calendar_collections.sync_token,excluded.sync_token),ctag=excluded.ctag",
            params![id,account_id,calendar.href,calendar.href,calendar.name,color,enabled,calendar.sync_token,calendar.ctag]
        ).map_err(to_string)?;
    }
    Ok(())
}

fn discover_collections(start_url: &str, auth: &Auth) -> Result<Vec<RemoteCollection>, String> {
    let discovery_url = if start_url.contains("apidata.googleusercontent.com/caldav/") {
        start_url.to_string()
    } else {
        join_url(start_url, "/.well-known/caldav")?
    };
    let principal_body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/><d:calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"/></d:prop></d:propfind>"#;
    let (first_url, first) = propfind_with_url(&discovery_url, auth, "0", principal_body)
        .or_else(|_| propfind_with_url(start_url, auth, "0", principal_body))?;
    let principal_href = xml_first_inner(&first, "current-user-principal")
        .and_then(|inner| xml_first_text(&inner, "href"));
    let principal_url = principal_href
        .as_deref()
        .map(|href| join_url(&first_url, href))
        .transpose()?
        .unwrap_or(first_url);
    let principal = propfind(&principal_url, auth, "0", principal_body)?;
    let home_href = xml_first_inner(&principal, "calendar-home-set")
        .and_then(|inner| xml_first_text(&inner, "href"))
        .ok_or_else(|| "CalDAV calendar-home-set was not found.".to_string())?;
    let home_url = join_url(&principal_url, &home_href)?;
    let body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/></d:prop></d:propfind>"#;
    let response = propfind(&home_url, auth, "1", body)?;
    let mut calendars = Vec::new();
    for block in xml_elements(&response, "response") {
        let resource_type = xml_first_inner(&block, "resourcetype").unwrap_or_default();
        let supported =
            xml_first_inner(&block, "supported-calendar-component-set").unwrap_or_default();
        if !resource_type.to_ascii_lowercase().contains("calendar")
            || (!supported.is_empty() && !supported.to_ascii_uppercase().contains("VEVENT"))
        {
            continue;
        }
        let href = xml_first_text(&block, "href")
            .ok_or_else(|| "Calendar collection has no href.".to_string())?;
        calendars.push(RemoteCollection {
            href: join_url(&home_url, &href)?,
            name: xml_first_text(&block, "displayname")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    href.trim_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or("Calendar")
                        .to_string()
                }),
            color: normalize_color(
                &xml_first_text(&block, "calendar-color").unwrap_or_else(|| "#64748b".to_string()),
            ),
            enabled_by_default: true,
            sync_token: xml_first_text(&block, "sync-token"),
            ctag: xml_first_text(&block, "getctag"),
        });
    }
    Ok(calendars)
}

fn query_calendar_day(
    url: &str,
    auth: &Auth,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<(String, Option<String>, String)>, String> {
    let start = DateTime::<Utc>::from_timestamp_millis(start_at)
        .ok_or_else(|| "Invalid calendar start date.".to_string())?
        .format("%Y%m%dT%H%M%SZ");
    let end = DateTime::<Utc>::from_timestamp_millis(end_at)
        .ok_or_else(|| "Invalid calendar end date.".to_string())?
        .format("%Y%m%dT%H%M%SZ");
    let body = format!(
        r#"<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="{start}" end="{end}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{start}" end="{end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#
    );
    let xml = dav_request("REPORT", url, auth, Some("1"), body)?
        .error_for_status()
        .map_err(to_string)?
        .text()
        .map_err(to_string)?;
    let mut output = Vec::new();
    for block in xml_elements(&xml, "response") {
        if let Some(raw) = xml_first_text(&block, "calendar-data") {
            let href = xml_first_text(&block, "href").unwrap_or_else(|| url.to_string());
            output.push((
                join_url(url, &href)?,
                xml_first_text(&block, "getetag"),
                raw,
            ));
        }
    }
    Ok(output)
}

fn sync_token_report(url: &str, auth: &Auth, token: &str) -> Result<Option<String>, String> {
    let body = format!(
        r#"<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>"#,
        xml_escape(token)
    );
    let response = dav_request("REPORT", url, auth, Some("1"), body)?;
    if !response.status().is_success() {
        return Err(format!(
            "Calendar sync token was rejected with {}.",
            response.status()
        ));
    }
    let xml = response.text().map_err(to_string)?;
    Ok(xml_first_text(&xml, "sync-token"))
}

fn propfind(url: &str, auth: &Auth, depth: &str, body: &str) -> Result<String, String> {
    propfind_with_url(url, auth, depth, body).map(|(_, body)| body)
}

fn propfind_with_url(
    url: &str,
    auth: &Auth,
    depth: &str,
    body: &str,
) -> Result<(String, String), String> {
    let response = dav_request("PROPFIND", url, auth, Some(depth), body.to_string())?
        .error_for_status()
        .map_err(to_string)?;
    let final_url = response.url().to_string();
    let body = response.text().map_err(to_string)?;
    Ok((final_url, body))
}

fn dav_request(
    method: &str,
    url: &str,
    auth: &Auth,
    depth: Option<&str>,
    body: String,
) -> Result<reqwest::blocking::Response, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(to_string)?;
    let mut request = http_client()?
        .request(method, url)
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body);
    if let Some(depth) = depth {
        request = request.header("Depth", depth);
    }
    authenticated(request, auth).send().map_err(to_string)
}

fn authenticated(request: RequestBuilder, auth: &Auth) -> RequestBuilder {
    match auth {
        Auth::Basic(user, password) => request.basic_auth(user, Some(password)),
    }
}

fn auth_for_account(db: &Connection, account: &AccountRecord) -> Result<Auth, String> {
    let secret = get_secret(db, &account.id)?;
    Ok(Auth::Basic(
        account.username.clone().unwrap_or_default(),
        secret,
    ))
}

fn parse_ical_events(raw: &str, account_username: Option<&str>) -> Vec<ParsedEvent> {
    let unfolded = unfold_ical(raw);
    let mut events = Vec::new();
    let mut in_event = false;
    let mut fields: Vec<String> = Vec::new();
    for line in unfolded.lines() {
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            in_event = true;
            fields.clear();
            continue;
        }
        if line.eq_ignore_ascii_case("END:VEVENT") {
            if let Some(event) = event_from_lines(&fields, account_username) {
                events.push(event);
            }
            in_event = false;
            continue;
        }
        if in_event {
            fields.push(line.to_string());
        }
    }
    events
}

fn expand_ical_events(
    raw: &str,
    account_username: Option<&str>,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ParsedEvent>, String> {
    let parsed = parse_ical_events(raw, account_username);
    let overrides = parsed
        .iter()
        .filter_map(|event| {
            event
                .recurrence_id_at
                .map(|at| ((event.uid.clone(), at), event))
        })
        .collect::<HashMap<_, _>>();
    let mut output = Vec::new();
    for event in parsed
        .iter()
        .filter(|event| event.recurrence_id_at.is_none())
    {
        if let Some(recurrence_set) = event.recurrence_set.as_deref() {
            let set: RRuleSet = recurrence_set
                .parse()
                .map_err(|_| "The calendar contains an invalid recurrence rule.".to_string())?;
            let duration = (event.end_at - event.start_at).max(0);
            let after = DateTime::<Utc>::from_timestamp_millis(
                start_at.saturating_sub(duration).saturating_sub(1),
            )
            .ok_or_else(|| "Invalid calendar date range.".to_string())?
            .with_timezone(&RRuleTz::UTC);
            let before = DateTime::<Utc>::from_timestamp_millis(end_at)
                .ok_or_else(|| "Invalid calendar date range.".to_string())?
                .with_timezone(&RRuleTz::UTC);
            let result = set.after(after).before(before).all(10_000);
            if result.limited {
                return Err("The calendar recurrence exceeds the safe expansion limit.".to_string());
            }
            for date in result.dates {
                let occurrence_at = date.timestamp_millis();
                if overrides.contains_key(&(event.uid.clone(), occurrence_at)) {
                    continue;
                }
                let mut occurrence = event.clone();
                occurrence.start_at = occurrence_at;
                occurrence.end_at = occurrence_at.saturating_add(duration);
                occurrence.recurrence_id = Some(occurrence_at.to_string());
                output.push(occurrence);
            }
        } else if event.start_at < end_at && event.end_at > start_at {
            output.push(event.clone());
        }
    }
    output.extend(parsed.into_iter().filter(|event| {
        event.recurrence_id_at.is_some() && event.start_at < end_at && event.end_at > start_at
    }));
    Ok(output)
}

fn event_from_lines(lines: &[String], account_username: Option<&str>) -> Option<ParsedEvent> {
    let mut values: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for line in lines {
        let (left, value) = line.split_once(':')?;
        let name = left.split(';').next()?.to_ascii_uppercase();
        values
            .entry(name)
            .or_default()
            .push((left.to_string(), ical_unescape(value)));
    }
    let uid = value(&values, "UID")?.to_string();
    let (start_left, start_value) = values.get("DTSTART")?.first()?;
    let (start_at, all_day, timezone) = parse_ical_datetime(start_left, start_value)?;
    let end_at = values
        .get("DTEND")
        .and_then(|items| items.first())
        .and_then(|(left, value)| parse_ical_datetime(left, value))
        .map(|item| item.0)
        .unwrap_or_else(|| {
            if all_day {
                start_at + 86_400_000
            } else {
                start_at
            }
        });
    let description = value(&values, "DESCRIPTION").map(str::to_string);
    let location = value(&values, "LOCATION").map(str::to_string);
    let event_url = value(&values, "URL").map(str::to_string);
    let join_url = event_url
        .as_deref()
        .filter(|url| is_meeting_url(url))
        .map(str::to_string)
        .or_else(|| location.as_deref().and_then(find_meeting_url))
        .or_else(|| description.as_deref().and_then(find_meeting_url));
    let attendee_status = account_username.and_then(|username| {
        values.get("ATTENDEE").and_then(|items| {
            items.iter().find_map(|(left, value)| {
                value
                    .trim_start_matches("mailto:")
                    .eq_ignore_ascii_case(username)
                    .then(|| parameter(left, "PARTSTAT"))
                    .flatten()
            })
        })
    });
    let recurrence_id_at = values
        .get("RECURRENCE-ID")
        .and_then(|items| items.first())
        .and_then(|(left, value)| parse_ical_datetime(left, value))
        .map(|value| value.0);
    let recurrence_lines = lines
        .iter()
        .filter(|line| {
            line.split_once(':').is_some_and(|(left, _)| {
                matches!(
                    left.split(';')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "DTSTART" | "RRULE" | "RDATE" | "EXDATE"
                )
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let recurrence_set = recurrence_lines
        .iter()
        .any(|line| {
            line.to_ascii_uppercase().starts_with("RRULE:")
                || line.to_ascii_uppercase().starts_with("RDATE")
        })
        .then(|| recurrence_lines.join("\n"));
    Some(ParsedEvent {
        uid,
        recurrence_id: value(&values, "RECURRENCE-ID").map(str::to_string),
        title: value(&values, "SUMMARY")
            .unwrap_or("Untitled event")
            .to_string(),
        description,
        location,
        start_at,
        end_at,
        all_day,
        status: value(&values, "STATUS").map(str::to_string),
        attendee_status,
        organizer: value(&values, "ORGANIZER")
            .map(|value| value.trim_start_matches("mailto:").to_string()),
        join_url,
        event_url,
        timezone,
        recurrence_id_at,
        recurrence_set,
    })
}

fn parse_ical_datetime(left: &str, value: &str) -> Option<(i64, bool, Option<String>)> {
    let is_date = parameter(left, "VALUE").is_some_and(|value| value.eq_ignore_ascii_case("DATE"))
        || value.len() == 8;
    if is_date {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        let local = Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .earliest()?;
        return Some((local.timestamp_millis(), true, None));
    }
    let timezone = parameter(left, "TZID");
    if value.ends_with('Z') {
        let date = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ").ok()?;
        return Some((
            Utc.from_utc_datetime(&date).timestamp_millis(),
            false,
            Some("UTC".to_string()),
        ));
    }
    let date = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M"))
        .ok()?;
    if let Some(ref tzid) = timezone {
        if let Ok(tz) = tzid.parse::<chrono_tz::Tz>() {
            return tz
                .from_local_datetime(&date)
                .earliest()
                .map(|dt| (dt.timestamp_millis(), false, timezone));
        }
    }
    Local
        .from_local_datetime(&date)
        .earliest()
        .map(|dt| (dt.timestamp_millis(), false, timezone))
}

fn list_account_records(db: &Connection) -> Result<Vec<AccountRecord>, String> {
    let mut statement = db.prepare("SELECT id,provider,auth_type,name,server_url,username,calendar_enabled,created_at,updated_at FROM calendar_accounts ORDER BY provider,name COLLATE NOCASE").map_err(to_string)?;
    let rows = statement
        .query_map([], |row| {
            Ok(AccountRecord {
                id: row.get(0)?,
                provider: row.get(1)?,
                auth_type: row.get(2)?,
                name: row.get(3)?,
                server_url: row.get(4)?,
                username: row.get(5)?,
                calendar_enabled: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(rows)
}
fn account_record(db: &Connection, id: &str) -> Result<AccountRecord, String> {
    db.query_row("SELECT id,provider,auth_type,name,server_url,username,calendar_enabled,created_at,updated_at FROM calendar_accounts WHERE id=?1",params![id],|row|Ok(AccountRecord{id:row.get(0)?,provider:row.get(1)?,auth_type:row.get(2)?,name:row.get(3)?,server_url:row.get(4)?,username:row.get(5)?,calendar_enabled:row.get::<_,i64>(6)? != 0,created_at:row.get(7)?,updated_at:row.get(8)?})).optional().map_err(to_string)?.ok_or_else(||"Calendar account not found.".to_string())
}
fn get_account(db: &Connection, id: &str) -> Result<Option<CalendarAccount>, String> {
    account_record(db, id)
        .ok()
        .map(|record| account_from_record(db, record))
        .transpose()
}
fn account_from_record(db: &Connection, record: AccountRecord) -> Result<CalendarAccount, String> {
    let mut statement=db.prepare("SELECT id,account_id,remote_id,href,name,color,enabled,last_synced_at FROM calendar_collections WHERE account_id=?1 ORDER BY name COLLATE NOCASE").map_err(to_string)?;
    let calendars = statement
        .query_map(params![record.id], |row| {
            Ok(CalendarCollection {
                id: row.get(0)?,
                account_id: row.get(1)?,
                remote_id: row.get(2)?,
                href: row.get(3)?,
                name: row.get(4)?,
                color: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                last_synced_at: row.get(7)?,
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    let has_credential: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM calendar_credentials WHERE account_id=?1)",
            params![record.id],
            |row| row.get(0),
        )
        .map_err(to_string)?;
    Ok(CalendarAccount {
        id: record.id.clone(),
        provider: record.provider,
        auth_type: record.auth_type,
        name: record.name,
        server_url: record.server_url,
        username: record.username,
        has_credential,
        calendar_enabled: record.calendar_enabled,
        calendars,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

fn normalize_subscription_url(value: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(value.trim())
        .map_err(|_| "Enter a valid secret iCal URL.".to_string())?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(
            "Calendar subscriptions require HTTPS, except for loopback development servers."
                .to_string(),
        );
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Enter a valid secret iCal URL.".to_string());
    }
    Ok(parsed.to_string())
}

fn google_oauth_error_message(
    status: StatusCode,
    response: &Value,
    sensitive_values: &[&str],
) -> String {
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error");
    let description = response
        .get("error_description")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut detail = match description {
        Some(description) => format!("{error}: {description}"),
        None => error.to_string(),
    };
    for sensitive_value in sensitive_values {
        if !sensitive_value.is_empty() {
            detail = detail.replace(sensitive_value, "[redacted]");
        }
    }
    let detail = detail
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect::<String>();
    format!("Google rejected the authorization code ({status}: {detail}).")
}

fn google_calendar_api_error_message(action: &str, status: StatusCode, response: &Value) -> String {
    let error = response.get("error").unwrap_or(&Value::Null);
    let reason = error
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("reason"))
        .and_then(Value::as_str)
        .or_else(|| error.get("status").and_then(Value::as_str));
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut detail = match (reason, message) {
        (Some(reason), Some(message)) => format!("{reason}: {message}"),
        (Some(reason), None) => reason.to_string(),
        (None, Some(message)) => message.to_string(),
        (None, None) => "unknown_error".to_string(),
    };
    detail = detail
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect();
    if reason == Some("accessNotConfigured") {
        detail.push_str(
            " Enable the Google Calendar API in this OAuth client's Google Cloud project.",
        );
    } else if matches!(reason, Some("insufficientPermissions" | "forbidden")) {
        detail.push_str(" Reconnect and grant Google Calendar read access.");
    }
    format!("Google Calendar rejected the {action} ({status}: {detail}).")
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn google_access_token(db: &Connection, account: &AccountRecord) -> Result<String, String> {
    let refresh_token = get_secret(db, &account.id)
        .map_err(|_| "Google authorization is missing. Reconnect the account.".to_string())?;
    let response = http_client()?
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", GOOGLE_OAUTH_CLIENT_ID),
            ("client_secret", GOOGLE_OAUTH_CLIENT_SECRET),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .map_err(|_| "Could not refresh Google authorization.".to_string())?
        .error_for_status()
        .map_err(|_| {
            "Google authorization expired or was revoked. Reconnect the account.".to_string()
        })?;
    let value: Value = response
        .json()
        .map_err(|_| "Google returned an invalid token response.".to_string())?;
    value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Google did not return an access token.".to_string())
}

fn google_calendar_list(access_token: &str) -> Result<Vec<RemoteCollection>, String> {
    let mut calendars = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut url = reqwest::Url::parse(&format!("{GOOGLE_API_URL}/users/me/calendarList"))
            .map_err(to_string)?;
        url.query_pairs_mut()
            .append_pair("maxResults", "250")
            .append_pair("showHidden", "true");
        if let Some(token) = page_token.as_deref() {
            url.query_pairs_mut().append_pair("pageToken", token);
        }
        let response = http_client()?
            .get(url)
            .bearer_auth(access_token)
            .send()
            .map_err(|_| "Could not load Google calendars.".to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let error = response.json::<Value>().unwrap_or(Value::Null);
            return Err(google_calendar_api_error_message(
                "calendar list request",
                status,
                &error,
            ));
        }
        let value: Value = response
            .json()
            .map_err(|_| "Google returned an invalid calendar list.".to_string())?;
        for item in value
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            calendars.push(RemoteCollection {
                href: id.to_string(),
                name: item
                    .get("summaryOverride")
                    .or_else(|| item.get("summary"))
                    .and_then(Value::as_str)
                    .unwrap_or("Calendar")
                    .to_string(),
                color: normalize_color(
                    item.get("backgroundColor")
                        .and_then(Value::as_str)
                        .unwrap_or("#64748b"),
                ),
                enabled_by_default: item
                    .get("primary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                sync_token: None,
                ctag: None,
            });
        }
        page_token = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    Ok(calendars)
}

fn store_google_collections(
    db: &Connection,
    account_id: &str,
    access_token: &str,
    now: i64,
) -> Result<(), String> {
    let calendars = google_calendar_list(access_token)?;
    if calendars.is_empty() {
        return Err("This Google account has no calendars.".to_string());
    }
    store_discovered_collections(db, account_id, calendars, now)
}

fn google_event_timestamp(value: &Value, field: &str) -> Option<(i64, bool, Option<String>)> {
    let data = value.get(field)?;
    if let Some(date_time) = data.get("dateTime").and_then(Value::as_str) {
        let timestamp = DateTime::parse_from_rfc3339(date_time)
            .ok()?
            .timestamp_millis();
        return Some((
            timestamp,
            false,
            data.get("timeZone")
                .and_then(Value::as_str)
                .map(str::to_string),
        ));
    }
    let date = NaiveDate::parse_from_str(data.get("date")?.as_str()?, "%Y-%m-%d").ok()?;
    let timestamp = Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()?
        .timestamp_millis();
    Some((timestamp, true, None))
}

fn sync_google_day(
    db: &Connection,
    account: &AccountRecord,
    collection: &CollectionRecord,
    access_token: &str,
    date: &str,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> Result<(), String> {
    let mut events = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut url =
            reqwest::Url::parse(&format!("{GOOGLE_API_URL}/calendars/")).map_err(to_string)?;
        url.path_segments_mut()
            .map_err(|_| "Could not build Google Calendar URL.".to_string())?
            .pop_if_empty()
            .push(&collection.href)
            .push("events");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair(
                    "timeMin",
                    &DateTime::<Utc>::from_timestamp_millis(start_at)
                        .ok_or_else(|| "Invalid calendar range.".to_string())?
                        .to_rfc3339(),
                )
                .append_pair(
                    "timeMax",
                    &DateTime::<Utc>::from_timestamp_millis(end_at)
                        .ok_or_else(|| "Invalid calendar range.".to_string())?
                        .to_rfc3339(),
                )
                .append_pair("singleEvents", "true")
                .append_pair("showDeleted", "true")
                .append_pair("maxResults", "2500");
            if let Some(token) = page_token.as_deref() {
                query.append_pair("pageToken", token);
            }
        }
        let response = http_client()?
            .get(url)
            .bearer_auth(access_token)
            .send()
            .map_err(|_| "Could not load Google Calendar events.".to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let error = response.json::<Value>().unwrap_or(Value::Null);
            return Err(google_calendar_api_error_message(
                "event request",
                status,
                &error,
            ));
        }
        let value: Value = response
            .json()
            .map_err(|_| "Google returned invalid event data.".to_string())?;
        events.extend(
            value
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        page_token = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    db.execute(
        "DELETE FROM calendar_events WHERE collection_id=?1 AND start_at < ?3 AND end_at > ?2",
        params![collection.id, start_at, end_at],
    )
    .map_err(to_string)?;
    for event in events {
        if event.get("status").and_then(Value::as_str) == Some("cancelled") {
            continue;
        }
        let Some(uid) = event.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some((event_start, all_day, timezone)) = google_event_timestamp(&event, "start") else {
            continue;
        };
        let Some((event_end, _, _)) = google_event_timestamp(&event, "end") else {
            continue;
        };
        if event_start >= end_at || event_end <= start_at {
            continue;
        }
        let attendee_status = event
            .get("attendees")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("self").and_then(Value::as_bool) == Some(true))
            })
            .and_then(|item| item.get("responseStatus"))
            .and_then(Value::as_str);
        let join_url = event
            .get("hangoutLink")
            .and_then(Value::as_str)
            .or_else(|| {
                event
                    .get("conferenceData")
                    .and_then(|data| data.get("entryPoints"))
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("entryPointType").and_then(Value::as_str) == Some("video")
                        })
                    })
                    .and_then(|item| item.get("uri"))
                    .and_then(Value::as_str)
            });
        let recurrence_id = event
            .get("originalStartTime")
            .and_then(|value| value.get("dateTime").or_else(|| value.get("date")))
            .and_then(Value::as_str);
        let recurrence_key = recurrence_id
            .map(str::to_string)
            .unwrap_or_else(|| event_start.to_string());
        let row_id = format!("calendar:{}:{}:{}", collection.id, uid, recurrence_key);
        db.execute(
            "INSERT INTO calendar_events (id,collection_id,resource_href,uid,recurrence_id,title,description,location,start_at,end_at,all_day,status,attendee_status,organizer,join_url,event_url,timezone,fetched_at)
             VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,location=excluded.location,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,status=excluded.status,attendee_status=excluded.attendee_status,organizer=excluded.organizer,join_url=excluded.join_url,event_url=excluded.event_url,timezone=excluded.timezone,fetched_at=excluded.fetched_at",
            params![row_id,collection.id,uid,recurrence_id,event.get("summary").and_then(Value::as_str).unwrap_or("Untitled event"),event.get("description").and_then(Value::as_str),event.get("location").and_then(Value::as_str),event_start,event_end,all_day,event.get("status").and_then(Value::as_str),attendee_status,event.get("organizer").and_then(|value| value.get("email")).and_then(Value::as_str),join_url,event.get("htmlLink").and_then(Value::as_str),timezone,now]
        ).map_err(to_string)?;
    }
    db.execute("INSERT INTO calendar_sync_ranges (collection_id,date,synced_at) VALUES (?1,?2,?3) ON CONFLICT(collection_id,date) DO UPDATE SET synced_at=excluded.synced_at", params![collection.id,date,now]).map_err(to_string)?;
    db.execute(
        "UPDATE calendar_collections SET last_synced_at=?1 WHERE id=?2",
        params![now, collection.id],
    )
    .map_err(to_string)?;
    let _ = account;
    Ok(())
}

fn redacted_source_host(value: &str) -> Result<String, String> {
    let parsed =
        reqwest::Url::parse(value).map_err(|_| "Enter a valid secret iCal URL.".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Enter a valid secret iCal URL.".to_string())?;
    Ok(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

fn validate_ical_feed(url: &str) -> Result<(), String> {
    let response = http_client()?
        .get(url)
        .send()
        .map_err(|_| {
            "Could not download the calendar feed. Check the URL and your connection.".to_string()
        })?
        .error_for_status()
        .map_err(|_| "The calendar feed rejected the request.".to_string())?;
    let mut bytes = Vec::new();
    response
        .take((MAX_ICAL_FEED_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the calendar feed.".to_string())?;
    if bytes.len() > MAX_ICAL_FEED_BYTES {
        return Err("The calendar feed is too large.".to_string());
    }
    let raw = String::from_utf8(bytes)
        .map_err(|_| "The calendar feed is not valid UTF-8.".to_string())?;
    if !raw.to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
        return Err("The URL did not return a valid iCal calendar.".to_string());
    }
    Ok(())
}

fn normalize_server_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|_| "Enter a valid CalDAV server URL.".to_string())?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err("CalDAV requires HTTPS, except for loopback development servers.".to_string());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}
fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(to_string)
}
fn join_url(base: &str, href: &str) -> Result<String, String> {
    reqwest::Url::parse(base)
        .and_then(|url| url.join(href))
        .map(|url| url.to_string())
        .map_err(to_string)
}
fn set_secret(db: &Connection, id: &str, value: &str, now: i64) -> Result<(), String> {
    db.execute(
        "INSERT INTO calendar_credentials (account_id,secret,updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(account_id) DO UPDATE SET secret=excluded.secret,updated_at=excluded.updated_at",
        params![id, value, now],
    )
    .map_err(to_string)?;
    Ok(())
}
fn get_secret(db: &Connection, id: &str) -> Result<String, String> {
    db.query_row(
        "SELECT secret FROM calendar_credentials WHERE account_id=?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(to_string)?
    .ok_or_else(|| "Calendar credentials are missing. Reconnect the account.".to_string())
}
fn stable_hash(value: &str) -> u64 {
    value.bytes().fold(1469598103934665603_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(1099511628211)
    })
}
fn normalize_color(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 7
        && value.starts_with('#')
        && value[1..7].chars().all(|c| c.is_ascii_hexdigit())
    {
        value[..7].to_ascii_lowercase()
    } else {
        "#64748b".to_string()
    }
}
fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn value<'a>(values: &'a HashMap<String, Vec<(String, String)>>, name: &str) -> Option<&'a str> {
    values.get(name)?.first().map(|(_, value)| value.as_str())
}
fn parameter(left: &str, name: &str) -> Option<String> {
    left.split(';').skip(1).find_map(|part| {
        let (k, v) = part.split_once('=')?;
        k.eq_ignore_ascii_case(name)
            .then(|| v.trim_matches('"').to_string())
    })
}
fn unfold_ical(raw: &str) -> String {
    raw.replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "")
        .replace("\r\n", "\n")
}
fn ical_unescape(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}
fn find_meeting_url(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .map(|part| part.trim_matches(|c: char| ",.;()<>[]{}\"'".contains(c)))
        .find(|part| is_meeting_url(part))
        .map(str::to_string)
}
fn is_meeting_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http")
        && (lower.contains("meet.google.com/")
            || lower.contains("zoom.us/")
            || lower.contains("teams.microsoft.com/")
            || lower.contains("webex.com/"))
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
fn xml_first_text(xml: &str, local: &str) -> Option<String> {
    xml_elements(xml, local)
        .into_iter()
        .next()
        .map(|value| xml_unescape(strip_xml_tags(&value).trim()))
}
fn xml_first_inner(xml: &str, local: &str) -> Option<String> {
    xml_elements(xml, local).into_iter().next()
}
fn strip_xml_tags(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
}
fn xml_elements(xml: &str, local: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut offset = 0;
    while let Some(relative) = xml[offset..].find('<') {
        let start = offset + relative;
        let rest = &xml[start + 1..];
        if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
            offset = start + 1;
            continue;
        }
        let name_end = rest
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(rest.len());
        let name = &rest[..name_end];
        if name.rsplit(':').next() != Some(local) {
            offset = start + 1;
            continue;
        }
        let open_end = match xml[start..].find('>') {
            Some(v) => start + v,
            None => break,
        };
        if xml[..=open_end].ends_with("/>") {
            output.push(String::new());
            offset = open_end + 1;
            continue;
        }
        let close = format!("</{name}>");
        if let Some(close_rel) = xml[open_end + 1..].find(&close) {
            let content_start = open_end + 1;
            let content_end = content_start + close_rel;
            output.push(xml[content_start..content_end].to_string());
            offset = content_end + close.len();
        } else {
            offset = open_end + 1;
        }
    }
    output
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_google_sign_in_stops_before_opening_the_browser() {
        let db = Connection::open_in_memory().unwrap();
        let result = connect_google_account(
            &db,
            0,
            None,
            |_| panic!("cancelled sign-in must not open the browser"),
            || true,
        );
        assert_eq!(result.unwrap_err(), "Google sign-in was cancelled.");
    }

    #[test]
    fn google_oauth_callback_clears_sensitive_query_and_closes_tab() {
        let page = google_oauth_callback_page(false);

        assert!(page.contains("history.replaceState(null,\"\",\"/oauth/google/complete\")"));
        assert!(page.contains("window.close()"));
        assert!(!page.contains("code="));
        assert!(!page.contains("state="));
    }

    #[test]
    fn desktop_google_oauth_credentials_are_compiled() {
        assert!(GOOGLE_OAUTH_CLIENT_ID.ends_with(".apps.googleusercontent.com"));
        assert!(GOOGLE_OAUTH_CLIENT_SECRET.starts_with("GOCSPX-"));
    }

    #[test]
    fn reports_google_oauth_error_details() {
        let error = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "PKCE verification failed"
        });
        assert_eq!(
            google_oauth_error_message(StatusCode::BAD_REQUEST, &error, &[]),
            "Google rejected the authorization code (400 Bad Request: invalid_grant: PKCE verification failed)."
        );
    }

    #[test]
    fn reports_actionable_google_calendar_api_errors() {
        let error = serde_json::json!({
            "error": {
                "code": 403,
                "message": "Google Calendar API has not been used in this project.",
                "errors": [{ "reason": "accessNotConfigured" }],
                "status": "PERMISSION_DENIED"
            }
        });
        assert_eq!(
            google_calendar_api_error_message(
                "calendar list request",
                StatusCode::FORBIDDEN,
                &error,
            ),
            "Google Calendar rejected the calendar list request (403 Forbidden: accessNotConfigured: Google Calendar API has not been used in this project. Enable the Google Calendar API in this OAuth client's Google Cloud project.)."
        );
    }

    #[test]
    fn newly_discovered_google_account_enables_only_primary_calendar() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_database(&db).unwrap();
        db.execute("INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at) VALUES ('g','google','oauth','person@example.com','https://www.googleapis.com/calendar/v3','person@example.com',1,1)",[]).unwrap();

        let calendars = vec![
            RemoteCollection {
                href: "person@example.com".into(),
                name: "Personal".into(),
                color: "#123456".into(),
                enabled_by_default: true,
                sync_token: None,
                ctag: None,
            },
            RemoteCollection {
                href: "team@example.com".into(),
                name: "Shared team".into(),
                color: "#654321".into(),
                enabled_by_default: false,
                sync_token: None,
                ctag: None,
            },
        ];
        store_discovered_collections(&db, "g", calendars.clone(), 2).unwrap();

        let account = get_account(&db, "g").unwrap().unwrap();
        assert!(
            account
                .calendars
                .iter()
                .find(|item| item.name == "Personal")
                .unwrap()
                .enabled
        );
        assert!(
            !account
                .calendars
                .iter()
                .find(|item| item.name == "Shared team")
                .unwrap()
                .enabled
        );

        db.execute(
            "UPDATE calendar_collections SET enabled=1 WHERE href='team@example.com'",
            [],
        )
        .unwrap();
        store_discovered_collections(&db, "g", calendars, 3).unwrap();
        let account = get_account(&db, "g").unwrap().unwrap();
        assert!(
            account
                .calendars
                .iter()
                .find(|item| item.name == "Shared team")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn redacts_google_oauth_request_secrets_from_errors() {
        let error = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "code secret-code did not match verifier secret-verifier"
        });
        let message = google_oauth_error_message(
            StatusCode::BAD_REQUEST,
            &error,
            &["secret-code", "secret-verifier"],
        );
        assert_eq!(
            message,
            "Google rejected the authorization code (400 Bad Request: invalid_grant: code [redacted] did not match verifier [redacted])."
        );
        assert!(!message.contains("secret-code"));
        assert!(!message.contains("secret-verifier"));
    }

    #[test]
    fn parses_timed_and_all_day_events() {
        let events=parse_ical_events("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T100000Z\r\nSUMMARY:Standup\r\nLOCATION:https://meet.google.com/abc-defg-hij\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:two\r\nDTSTART;VALUE=DATE:20260715\r\nDTEND;VALUE=DATE:20260716\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR", None);
        assert_eq!(events.len(), 2);
        assert!(!events[0].all_day);
        assert!(events[1].all_day);
        assert_eq!(
            events[0].join_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
    }
    #[test]
    fn expands_recurring_events_and_exclusions() {
        let raw = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:daily\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20260716T090000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let start = DateTime::parse_from_rfc3339("2026-07-15T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let end = DateTime::parse_from_rfc3339("2026-07-18T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let events = expand_ical_events(raw, None, start, end).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Daily");
    }
    #[test]
    fn parses_namespaced_xml() {
        let xml="<d:multistatus><d:response><d:href>/cal/</d:href><d:propstat><d:prop><x:displayname>Work &amp; Life</x:displayname></d:prop></d:propstat></d:response></d:multistatus>";
        let response = xml_elements(xml, "response");
        assert_eq!(
            xml_first_text(&response[0], "displayname").as_deref(),
            Some("Work & Life")
        );
    }
    #[test]
    fn rejects_insecure_remote_servers() {
        assert!(normalize_server_url("http://example.com/calendar").is_err());
        assert!(normalize_server_url("http://127.0.0.1:8080/calendar").is_ok());
    }
    #[test]
    fn validates_subscription_urls_without_exposing_the_secret() {
        assert!(normalize_subscription_url("http://example.com/private.ics").is_err());
        assert!(normalize_subscription_url("http://127.0.0.1:8080/private.ics").is_ok());
        assert_eq!(
            redacted_source_host("https://calendar.example.com/private/token.ics").unwrap(),
            "https://calendar.example.com"
        );
    }

    #[test]
    fn migrates_calendar_resources_with_last_modified() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE calendar_accounts (id TEXT PRIMARY KEY,provider TEXT NOT NULL,auth_type TEXT NOT NULL,name TEXT NOT NULL,server_url TEXT NOT NULL,username TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
        init_database(&db).unwrap();
        let columns = db
            .prepare("PRAGMA table_info(calendar_resources)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "last_modified"));
    }
    #[test]
    fn lists_enabled_overlapping_cached_events() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_database(&db).unwrap();
        db.execute("INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at) VALUES ('a','caldav','basic','Work','https://example.com',NULL,1,1)",[]).unwrap();
        db.execute("INSERT INTO calendar_collections (id,account_id,remote_id,href,name,color,enabled) VALUES ('c','a','remote','https://example.com/c','Team','#123456',1)",[]).unwrap();
        db.execute("INSERT INTO calendar_events (id,collection_id,resource_href,uid,title,start_at,end_at,all_day,fetched_at) VALUES ('e','c','r','uid','Meeting',100,200,0,1)",[]).unwrap();
        assert_eq!(
            list_events(&db, "1970-01-01", 150, 250)
                .unwrap()
                .events
                .len(),
            1
        );
        db.execute("UPDATE calendar_collections SET enabled=0 WHERE id='c'", [])
            .unwrap();
        assert!(list_events(&db, "1970-01-01", 150, 250)
            .unwrap()
            .events
            .is_empty());
    }

    #[test]
    fn sqlite_credential_migration_removes_legacy_accounts_only_once() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE calendar_accounts (id TEXT PRIMARY KEY,provider TEXT NOT NULL,auth_type TEXT NOT NULL,name TEXT NOT NULL,server_url TEXT NOT NULL,username TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO calendar_accounts VALUES ('legacy','caldav','basic','Legacy','https://example.com','user',1,1);").unwrap();

        init_database(&db).unwrap();
        let legacy_count: i64 = db
            .query_row("SELECT COUNT(*) FROM calendar_accounts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(legacy_count, 0);

        db.execute("INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at) VALUES ('new','caldav','basic','New','https://example.com','user',2,2)", []).unwrap();
        set_secret(&db, "new", "password", 2).unwrap();
        init_database(&db).unwrap();

        let current_count: i64 = db
            .query_row("SELECT COUNT(*) FROM calendar_accounts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(current_count, 1);
        assert_eq!(get_secret(&db, "new").unwrap(), "password");
    }

    #[test]
    fn sqlite_credentials_are_private_and_cascade_with_accounts() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_database(&db).unwrap();
        db.execute("INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at) VALUES ('a','caldav','basic','Work','https://example.com','user',1,1)", []).unwrap();
        set_secret(&db, "a", "private-password", 1).unwrap();

        let account = get_account(&db, "a").unwrap().unwrap();
        let serialized = serde_json::to_string(&account).unwrap();
        assert!(account.has_credential);
        assert!(!serialized.contains("private-password"));
        assert!(!serialized.contains("secret"));

        delete_account(&db, "a").unwrap();
        let credential_count: i64 = db
            .query_row("SELECT COUNT(*) FROM calendar_credentials", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(credential_count, 0);
    }

    #[test]
    fn pausing_google_calendar_preserves_collection_choices_and_hides_events() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_database(&db).unwrap();
        db.execute("INSERT INTO calendar_accounts (id,provider,auth_type,name,server_url,username,created_at,updated_at) VALUES ('g','google','oauth','person@example.com','https://www.googleapis.com/calendar/v3','person@example.com',1,1)",[]).unwrap();
        db.execute("INSERT INTO calendar_collections (id,account_id,remote_id,href,name,color,enabled) VALUES ('gc','g','primary','primary','Personal','#123456',1)",[]).unwrap();
        db.execute("INSERT INTO calendar_events (id,collection_id,resource_href,uid,title,start_at,end_at,all_day,fetched_at) VALUES ('ge','gc','event','event','Meeting',100,200,0,1)",[]).unwrap();

        let account = update_calendar_service(
            &db,
            CalendarServiceInput {
                account_id: "g".into(),
                enabled: false,
            },
            2,
        )
        .unwrap();

        assert!(!account.calendar_enabled);
        assert!(account.calendars[0].enabled);
        assert!(list_events(&db, "1970-01-01", 150, 250)
            .unwrap()
            .events
            .is_empty());
    }

    #[test]
    fn parses_google_timed_and_all_day_boundaries() {
        let timed = serde_json::json!({"start":{"dateTime":"2026-07-16T09:30:00+02:00","timeZone":"Europe/Vienna"}});
        let (timestamp, all_day, timezone) = google_event_timestamp(&timed, "start").unwrap();
        assert_eq!(timestamp, 1_784_187_000_000);
        assert!(!all_day);
        assert_eq!(timezone.as_deref(), Some("Europe/Vienna"));

        let all_day_event = serde_json::json!({"start":{"date":"2026-07-16"}});
        let (_, all_day, _) = google_event_timestamp(&all_day_event, "start").unwrap();
        assert!(all_day);
    }
}
