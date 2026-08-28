export const TRELLO_CREDENTIAL_URLS = Object.freeze({
  apps: "https://trello.com/apps/admin",
  powerUps: "https://trello.com/power-ups/admin",
  legacyAppKey: "https://trello.com/app-key",
  setupGuide: "https://support.atlassian.com/trello/docs/getting-started-with-trello-rest-api/",
});

function normalizeCredentialBaseUrl(value, fallback) {
  const trimmed = value?.trim().replace(/\/+$/, "") || "";
  if (!trimmed) return fallback;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return `https://${trimmed}`;
}

export function credentialUrl(provider, baseUrl = "", apiKey = "") {
  if (provider === "github") {
    return "https://github.com/settings/personal-access-tokens/new";
  }
  if (provider === "gitlab") {
    return `${normalizeCredentialBaseUrl(baseUrl, "https://gitlab.com")}/-/user_settings/personal_access_tokens`;
  }
  if (provider === "trello") {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return "";
    return `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Server%20Token&key=${encodeURIComponent(trimmedApiKey)}`;
  }
  return "";
}
