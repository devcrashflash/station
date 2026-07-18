import { useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { providerLabels, pullRequestTestItems, safeJson } from "@/lib/domain";

const statusOptions = [
  { value: "reviewing", label: "Reviewing" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "tested", label: "Tested" },
  { value: "done", label: "Done" },
];

export function PullRequestPanel({ pullRequests, onUpdatePullRequest }) {
  return (
    <Panel title="Pull requests" icon={GitPullRequest}>
      {pullRequests.length === 0 ? (
        <EmptyState text="No pull requests tracked. Paste a PR or MR link into the smart inbox." />
      ) : (
        <div className="grid gap-3">
          {pullRequests.map((pullRequest) => (
            <PullRequestItem
              key={pullRequest.id}
              pullRequest={pullRequest}
              onUpdatePullRequest={onUpdatePullRequest}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function PullRequestItem({ pullRequest, onUpdatePullRequest }) {
  const [notes, setNotes] = useState(pullRequest.reviewNotes);
  const state = safeJson(pullRequest.testState);

  useEffect(() => {
    setNotes(pullRequest.reviewNotes);
  }, [pullRequest.reviewNotes]);

  function updateTestState(key, checked) {
    onUpdatePullRequest({
      id: pullRequest.id,
      testState: JSON.stringify({ ...state, [key]: checked === true }),
    });
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            className="block min-w-0 max-w-full break-words font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
            href={pullRequest.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            {pullRequest.title}
          </a>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {providerLabels[pullRequest.provider] || pullRequest.provider} · {pullRequest.repoUrl}
            {pullRequest.externalState ? ` · ${pullRequest.externalState}` : ""}
          </p>
        </div>
        <SelectControl
          value={pullRequest.status}
          onValueChange={(status) => onUpdatePullRequest({ id: pullRequest.id, status })}
          options={statusOptions}
          triggerClassName="w-44"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        {pullRequestTestItems.map((item) => (
          <label key={item.id} className="inline-flex items-center gap-2 text-sm">
            <Checkbox
              checked={Boolean(state[item.id])}
              onCheckedChange={(checked) => updateTestState(item.id, checked)}
            />
            {item.label}
          </label>
        ))}
      </div>

      <Textarea
        className="mt-4 min-h-24 resize-y"
        value={notes}
        placeholder="Review notes"
        onBlur={() => onUpdatePullRequest({ id: pullRequest.id, reviewNotes: notes })}
        onChange={(event) => setNotes(event.target.value)}
      />
    </div>
  );
}
