import test from "node:test";
import assert from "node:assert/strict";

import { TRELLO_CREDENTIAL_URLS, credentialUrl } from "./credentialLinks.js";

test("exposes the current and legacy Trello credential sources", () => {
  assert.deepEqual(TRELLO_CREDENTIAL_URLS, {
    apps: "https://trello.com/apps/admin",
    powerUps: "https://trello.com/power-ups/admin",
    legacyAppKey: "https://trello.com/app-key",
    setupGuide: "https://support.atlassian.com/trello/docs/getting-started-with-trello-rest-api/",
  });
});

test("builds a Trello token authorization URL after an API key is entered", () => {
  assert.equal(credentialUrl("trello", "", ""), "");
  assert.equal(
    credentialUrl("trello", "", " key with spaces "),
    "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Server%20Token&key=key%20with%20spaces",
  );
});

test("keeps GitHub and GitLab credential links working", () => {
  assert.equal(credentialUrl("github"), "https://github.com/settings/personal-access-tokens/new");
  assert.equal(
    credentialUrl("gitlab", "gitlab.example.com/"),
    "https://gitlab.example.com/-/user_settings/personal_access_tokens",
  );
});
