import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectControl } from "@/components/common/SelectControl";
import { api } from "@/lib/api";

export function JiraTicketWizard({ task, projects, onClose, onConvert }) {
  const [projectId, setProjectId] = useState("");
  const [types, setTypes] = useState([]);
  const [typeId, setTypeId] = useState("");
  const [metadata, setMetadata] = useState(null);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.body || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const submitting = useRef(false);
  const project = projects.find((item) => item.id === projectId);

  useEffect(() => {
    let active = true;
    setTypes([]); setTypeId(""); setMetadata(null); setError("");
    if (!projectId) return;
    setBusy(true);
    api.listJiraIssueTypes({ taskId: task.id, projectResourceId: projectId })
      .then((result) => { if (active) setTypes((result.issueTypes || []).filter((item) => !item.subtask)); })
      .catch((e) => { if (active) setError(e.message || String(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectId, task.id]);

  useEffect(() => {
    let active = true;
    setMetadata(null);
    if (!typeId) return;
    setBusy(true); setError("");
    api.jiraCreateMetadata({ taskId: task.id, projectResourceId: projectId, issueTypeId: typeId })
      .then((result) => { if (active) setMetadata(result); })
      .catch((e) => { if (active) setError(e.message || String(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [typeId, projectId, task.id]);

  async function submit(event) {
    event.preventDefault();
    if (submitting.current || attempted || busy || !metadata || metadata.unsupportedFields?.length || !title.trim()) return;
    submitting.current = true; setAttempted(true); setBusy(true); setError("");
    try {
      await onConvert({ taskId: task.id, projectResourceId: projectId, issueTypeId: typeId, title: title.trim(), description });
    } catch (e) {
      setError(e.message || String(e));
      setBusy(false);
    } finally { submitting.current = false; }
  }

  const recoveryUrl = error.match(/https:\/\/[a-z0-9.-]+\.atlassian\.net\/browse\/[A-Za-z0-9_-]+/)?.[0];
  return <Modal title="Create Jira ticket" onClose={() => !submitting.current && onClose()} contentClassName="sm:max-w-2xl">
    <form className="grid max-h-[75vh] gap-4 overflow-y-auto pr-1" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">Choose a connected Jira project and issue type, then review the ticket. Jira sets its initial status.</p>
      <Field><FieldLabel>Jira project</FieldLabel><SelectControl value={projectId} onValueChange={setProjectId} disabled={busy || attempted} placeholder="Choose a project" options={projects.map((item) => ({ value: item.id, label: `${item.name} · ${new URL(item.url).hostname}` }))} /></Field>
      {projectId && <Field><FieldLabel>Issue type</FieldLabel><SelectControl value={typeId} onValueChange={setTypeId} disabled={busy || attempted} placeholder="Choose an issue type" options={types.map((item) => ({ value: item.id, label: item.name }))} /></Field>}
      <Field><FieldLabel>Title</FieldLabel><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={attempted} required /></Field>
      <Field><FieldLabel>Description</FieldLabel><Textarea className="min-h-48" value={description} onChange={(e) => setDescription(e.target.value)} disabled={attempted} /></Field>
      {busy && <p className="text-sm text-muted-foreground">{attempted ? "Creating Jira issue…" : "Checking Jira project…"}</p>}
      {metadata?.unsupportedFields?.length > 0 && <p role="alert" className="text-sm text-destructive">Complete these required fields in Jira: {metadata.unsupportedFields.join(", ")}. Your Station task remains available.</p>}
      {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" disabled={submitting.current} onClick={onClose}>Cancel</Button>
        {(recoveryUrl || metadata?.openUrl || project?.url) && <a className="self-center text-sm underline" href={recoveryUrl || metadata?.openUrl || project.url} target="_blank" rel="noreferrer">Open in Jira</a>}
        <Button type="submit" disabled={busy || attempted || !metadata || metadata.unsupportedFields?.length > 0 || !title.trim()}>Create Jira ticket</Button>
      </div>
    </form>
  </Modal>;
}
