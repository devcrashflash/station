import test from "node:test";
import assert from "node:assert/strict";

import {
  canCreateTrelloTicket,
  normalizeTrelloMarkdown,
  trelloTicketDraftDescription,
} from "./trelloTicket.js";

test("converts Markdown hard breaks to Trello paragraph breaks", () => {
  const description = "**Client:** […]  \n**Url:** […]  \n**App Version**: […] Example: *1.0.18 (7587ae)*  \n**Browser Version**: […]";

  assert.equal(
    normalizeTrelloMarkdown(description),
    "**Client:** […]\n\n**Url:** […]\n\n**App Version**: […] Example: *1.0.18 (7587ae)*\n\n**Browser Version**: […]",
  );
});

test("keeps trailing spaces inside fenced code blocks", () => {
  assert.equal(
    normalizeTrelloMarkdown("Before  \n```text\ncode  \n```\nAfter"),
    "Before\n\n```text\ncode  \n```\nAfter",
  );
});

test("builds an editable Trello description from template and task content", () => {
  assert.equal(
    trelloTicketDraftDescription("## Acceptance criteria\n- [ ] Done", "Fix the login redirect"),
    "Fix the login redirect\n\n---\n\n## Acceptance criteria\n- [ ] Done",
  );
  assert.equal(trelloTicketDraftDescription("", "Task only"), "Task only");
  assert.equal(trelloTicketDraftDescription("Template only", ""), "Template only");
});

test("only offers Trello conversion for unlinked project tasks with boards", () => {
  const task = { id: "task_1", projectId: "project_1", sourceUrl: null };
  assert.equal(canCreateTrelloTicket(task, [{ id: "board_1" }]), true);
  assert.equal(canCreateTrelloTicket({ ...task, sourceUrl: "https://example.com" }, [{ id: "board_1" }]), false);
  assert.equal(canCreateTrelloTicket({ ...task, sourceProvider: "trello" }, [{ id: "board_1" }]), false);
  assert.equal(canCreateTrelloTicket(task, []), false);
  assert.equal(canCreateTrelloTicket({ id: "task_2" }, [{ id: "board_1" }]), false);
});
