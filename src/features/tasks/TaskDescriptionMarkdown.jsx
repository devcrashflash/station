import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkHideHtmlComments } from "@/lib/remarkHideHtmlComments";
import { cn } from "@/lib/utils";

const markdownComponents = {
  a({ className, node: _node, ...props }) {
    return (
      <a
        className={cn(
          "font-medium break-all text-blue-700 underline underline-offset-2 hover:text-blue-900",
          className,
        )}
        target="_blank"
        rel="noreferrer"
        {...props}
      />
    );
  },
  blockquote({ className, node: _node, ...props }) {
    return (
      <blockquote
        className={cn("border-l-2 border-border pl-4 text-muted-foreground", className)}
        {...props}
      />
    );
  },
  code({ className, node: _node, ...props }) {
    return (
      <code
        className={cn(
          "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-all text-foreground",
          className,
        )}
        {...props}
      />
    );
  },
  h1({ className, node: _node, ...props }) {
    return <h1 className={cn("text-2xl font-semibold leading-tight", className)} {...props} />;
  },
  h2({ className, node: _node, ...props }) {
    return <h2 className={cn("text-xl font-semibold leading-tight", className)} {...props} />;
  },
  h3({ className, node: _node, ...props }) {
    return <h3 className={cn("text-lg font-semibold leading-tight", className)} {...props} />;
  },
  h4({ className, node: _node, ...props }) {
    return <h4 className={cn("font-semibold leading-tight", className)} {...props} />;
  },
  hr({ className, node: _node, ...props }) {
    return <hr className={cn("border-border", className)} {...props} />;
  },
  li({ className, node: _node, ...props }) {
    return <li className={cn("pl-1", className)} {...props} />;
  },
  ol({ className, node: _node, ...props }) {
    return <ol className={cn("list-decimal space-y-1 pl-5", className)} {...props} />;
  },
  p({ className, node: _node, ...props }) {
    return <p className={cn("min-w-0 leading-6", className)} {...props} />;
  },
  pre({ className, node: _node, ...props }) {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-md bg-muted p-3 text-sm leading-6 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit",
          className,
        )}
        {...props}
      />
    );
  },
  table({ className, node: _node, ...props }) {
    return (
      <div className="overflow-x-auto">
        <table className={cn("w-full border-collapse text-sm", className)} {...props} />
      </div>
    );
  },
  tbody({ className, node: _node, ...props }) {
    return <tbody className={cn("divide-y divide-border", className)} {...props} />;
  },
  td({ className, node: _node, ...props }) {
    return <td className={cn("border border-border px-3 py-2 align-top", className)} {...props} />;
  },
  th({ className, node: _node, ...props }) {
    return (
      <th
        className={cn("border border-border bg-muted px-3 py-2 text-left font-medium", className)}
        {...props}
      />
    );
  },
  ul({ className, node: _node, ...props }) {
    return <ul className={cn("list-disc space-y-1 pl-5", className)} {...props} />;
  },
};

export function TaskDescriptionMarkdown({ children }) {
  return (
    <div className="grid min-w-0 max-w-full gap-4 overflow-hidden text-sm">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm, remarkHideHtmlComments]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
