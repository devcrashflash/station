export const providerLabels = {
  trello: "Trello",
  github: "GitHub",
  gitlab: "GitLab",
};

export const resourceKinds = [
  { value: "trello_board", label: "Trello board" },
  { value: "github_repo", label: "GitHub repository" },
  { value: "gitlab_repo", label: "GitLab repository" },
];

export const pullRequestTestItems = [
  { id: "checkout", label: "Branch checked out" },
  { id: "review", label: "Code reviewed" },
  { id: "tests", label: "Tests executed" },
];

export function safeJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}
