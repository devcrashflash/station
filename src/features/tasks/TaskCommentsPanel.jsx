import { ExternalLink, MessageSquare } from "lucide-react";
import { Highlight } from "prism-react-renderer";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { Badge } from "@/components/ui/badge";
import { TaskDescriptionMarkdown } from "@/features/tasks/TaskDescriptionMarkdown";
import { Prism } from "@/lib/prism";
import { diffLanguageForPath } from "@/lib/reviewDiff";

const commentKindLabels = {
  review: "Review",
  inline: "Code comment",
};

function formatCommentTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function TaskCommentsPanel({ comments = [] }) {
  const grouped = new Map();
  comments.forEach((comment) => {
    const key = comment.discussionId || comment.id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(comment);
  });
  const items = [...grouped.values()]
    .map((group) => group.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))))
    .sort((a, b) => String(a[0]?.createdAt || "").localeCompare(String(b[0]?.createdAt || "")));
  return (
    <Panel title="Comments" icon={MessageSquare}>
      {comments.length === 0 ? (
        <EmptyState text="No comments yet." />
      ) : (
        <div className="grid gap-3">
          {items.map((group) => {
            const comment = group[0];
            const context = group.find((item) => item.codeContext)?.codeContext;
            return (
              <article key={comment.discussionId || comment.id} className="min-w-0 overflow-hidden rounded-md border bg-muted/20">
                {context && <CommentDiffContext context={context} />}
                <div className="grid divide-y">
                  {group.map((item, index) => <CommentBody key={item.id} comment={item} reply={index > 0} />)}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function CommentBody({ comment, reply }) {
            const timestamp = formatCommentTimestamp(comment.createdAt || comment.updatedAt);
            const kindLabel = commentKindLabels[comment.kind];
  return (
              <div className={`min-w-0 p-4 ${reply ? "ml-6 border-l-2 border-muted-foreground/20" : ""}`}>
                <header className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{comment.author || "Unknown author"}</span>
                  {kindLabel && <Badge variant="outline">{kindLabel}</Badge>}
                  {timestamp && <time dateTime={comment.createdAt || comment.updatedAt}>{timestamp}</time>}
                  {comment.url && (
                    <a
                      className="ml-auto inline-flex items-center gap-1 font-medium text-blue-700 hover:text-blue-900 hover:underline"
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </header>
                <TaskDescriptionMarkdown>{comment.body}</TaskDescriptionMarkdown>
              </div>
  );
}

function CommentDiffContext({ context }) {
  const language = Prism.languages[diffLanguageForPath(context.path)] ? diffLanguageForPath(context.path) : "plain";
  return (
    <div className="border-b bg-muted/30">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <span className="min-w-0 flex-1 truncate font-mono">{context.path}</span>
        {(context.newLine || context.oldLine) && <span className="text-muted-foreground">Line {context.newLine || context.oldLine}</span>}
        {context.outdated && <Badge variant="outline">Outdated</Badge>}
      </div>
      {context.lines?.length ? (
        <pre className="overflow-x-auto py-2 font-mono text-xs">
          {context.lines.map((line, index) => (
            <div key={index} className={`flex min-w-max ${line.highlighted ? "bg-amber-300/25" : line.kind === "addition" ? "bg-emerald-500/10" : line.kind === "deletion" ? "bg-red-500/10" : ""}`}>
              <span className="w-10 select-none px-2 text-right text-muted-foreground">{line.oldLine || ""}</span>
              <span className="w-10 select-none px-2 text-right text-muted-foreground">{line.newLine || ""}</span>
              <span className="w-5 select-none text-muted-foreground">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}</span>
              <code className="pr-4"><Highlight code={line.content || " "} language={language}>{({ tokens, getTokenProps }) => tokens.flat().map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })} />)}</Highlight></code>
            </div>
          ))}
        </pre>
      ) : <p className="px-3 py-3 text-xs text-muted-foreground">Code context unavailable.</p>}
    </div>
  );
}
