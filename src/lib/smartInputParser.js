export function parseSmartInput(value) {
  const input = value.trim();
  const url = extractUrl(input);

  if (!url) {
    return {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: firstLine(input) || "New task",
    };
  }

  const parsedUrl = safeUrl(url);
  if (!parsedUrl) {
    return {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: firstLine(input) || "New task",
    };
  }

  const trelloBoard = parsedUrl.pathname.match(/^\/b\/([^/]+)/);
  if (parsedUrl.hostname.endsWith("trello.com") && trelloBoard) {
    return {
      kind: "trello_board",
      provider: "trello",
      externalId: trelloBoard[1],
      url,
      title: titleFromPath(parsedUrl, `Trello board ${trelloBoard[1]}`),
    };
  }

  const trelloCard = parsedUrl.pathname.match(/^\/c\/([^/]+)/);
  if (parsedUrl.hostname.endsWith("trello.com") && trelloCard) {
    return {
      kind: "trello_card",
      provider: "trello",
      externalId: trelloCard[1],
      url,
      title: titleFromPath(parsedUrl, `Trello card ${trelloCard[1]}`),
    };
  }

  const githubPull = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (parsedUrl.hostname.endsWith("github.com") && githubPull) {
    const [, owner, repo, number] = githubPull;
    return {
      kind: "pull_request",
      provider: "github",
      externalId: `${owner}/${repo}#${number}`,
      url,
      repoUrl: `${parsedUrl.origin}/${owner}/${repo}`,
      title: `${owner}/${repo} PR #${number}`,
    };
  }

  const githubIssue = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (parsedUrl.hostname.endsWith("github.com") && githubIssue) {
    const [, owner, repo, number] = githubIssue;
    return {
      kind: "github_issue",
      provider: "github",
      externalId: `${owner}/${repo}#${number}`,
      url,
      repoUrl: `${parsedUrl.origin}/${owner}/${repo}`,
      title: `${owner}/${repo} issue #${number}`,
    };
  }

  const gitlabMergeRequest = parsedUrl.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)/);
  if (gitlabMergeRequest) {
    const [, repoPath, number] = gitlabMergeRequest;
    return {
      kind: "merge_request",
      provider: "gitlab",
      externalId: `${repoPath}!${number}`,
      url,
      repoUrl: `${parsedUrl.origin}/${repoPath}`,
      title: `${repoPath} MR !${number}`,
    };
  }

  const gitlabIssue = parsedUrl.pathname.match(/^\/(.+)\/-\/issues\/(\d+)/);
  if (gitlabIssue) {
    const [, repoPath, number] = gitlabIssue;
    return {
      kind: "gitlab_issue",
      provider: "gitlab",
      externalId: `${repoPath}!${number}`,
      url,
      repoUrl: `${parsedUrl.origin}/${repoPath}`,
      title: `${repoPath} issue #${number}`,
    };
  }

  return {
    kind: "url",
    provider: null,
    externalId: url,
    url,
    title: titleFromPath(parsedUrl, url),
  };
}

export function plainTextTaskBody(input, title) {
  const trimmedInput = String(input || "").trim();
  if (!trimmedInput) return "";

  const lines = trimmedInput.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return "";

  const openingLine = normalizeWhitespace(lines[firstContentIndex]);
  const normalizedTitle = normalizeWhitespace(title);
  const matchesTitle = normalizedTitle && (
    openingLine === normalizedTitle || openingLine === `Tasks: ${normalizedTitle}`
  );

  if (!matchesTitle) return trimmedInput;
  return lines.slice(firstContentIndex + 1).join("\n").trim();
}

function extractUrl(input) {
  return input
    .split(/\s+/)
    .find((part) => part.startsWith("https://") || part.startsWith("http://"));
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function firstLine(input) {
  return input.split(/\r?\n/).find(Boolean)?.trim() || "";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleFromPath(parsedUrl, fallback) {
  const lastSegment = parsedUrl.pathname.split("/").filter(Boolean).at(-1);
  if (!lastSegment) {
    return fallback;
  }

  const title = decodeURIComponent(lastSegment).replace(/[-_]+/g, " ").trim();
  return title || fallback;
}
