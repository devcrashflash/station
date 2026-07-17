function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The review response is missing ${label}.`);
  }
  return value;
}

export function normalizeReviewDiffFile(value, fallbackPath = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The review response contains an invalid file diff.");
  }

  const path = requiredString(value.path || fallbackPath, "a file path");
  if (typeof value.diff !== "string") {
    throw new Error(`The review response contains an invalid diff for ${path}.`);
  }

  return {
    ...value,
    path,
    oldPath: typeof value.oldPath === "string" && value.oldPath.trim() ? value.oldPath : path,
    newPath: typeof value.newPath === "string" && value.newPath.trim() ? value.newPath : path,
    diff: value.diff,
  };
}

export function normalizeReviewDiffResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The desktop app returned an invalid review response.");
  }
  if (!Array.isArray(value.files)) {
    throw new Error("The review response is missing its changed-file list.");
  }

  const files = value.files.map((path) => requiredString(path, "a changed-file path"));
  const currentFile = value.currentFile == null
    ? null
    : normalizeReviewDiffFile(value.currentFile, files[0] || "");

  if (files.length > 0 && !currentFile) {
    throw new Error("The review response is missing the first changed-file diff.");
  }
  if (currentFile && !files.includes(currentFile.path)) {
    throw new Error("The review response returned a file outside its changed-file list.");
  }

  return {
    ...value,
    path: requiredString(value.path, "the local repository path"),
    branch: requiredString(value.branch, "the review branch"),
    baseRef: requiredString(value.baseRef, "the base branch"),
    headSha: requiredString(value.headSha, "the reviewed commit SHA"),
    files: [...new Set(files)],
    currentFile,
  };
}

export function normalizeReviewDrafts(value) {
  if (!Array.isArray(value)) {
    throw new Error("The desktop app returned an invalid review-draft response.");
  }
  return value.filter((draft) => draft && typeof draft === "object" && !Array.isArray(draft));
}

export function isClosedReviewState(value) {
  const state = String(value || "").trim().toLowerCase();
  return state === "closed" || state === "merged";
}

export function createLatestRequestGuard() {
  let sequence = 0;
  return {
    begin() {
      sequence += 1;
      return sequence;
    },
    isCurrent(request) {
      return request === sequence;
    },
    invalidate() {
      sequence += 1;
    },
  };
}
