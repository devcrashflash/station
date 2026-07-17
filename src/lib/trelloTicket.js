export function normalizeTrelloMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const normalized = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
    }

    if (!fence && / {2,}$/.test(line)) {
      normalized.push(line.replace(/ +$/, ""));
      if (lines[index + 1] !== "") normalized.push("");
    } else {
      normalized.push(line);
    }
  }

  return normalized.join("\n");
}

export function trelloTicketDraftDescription(templateDescription, taskDescription) {
  const sections = [taskDescription, templateDescription]
    .map((value) => normalizeTrelloMarkdown(value).trim())
    .filter(Boolean);
  return sections.join("\n\n---\n\n");
}

export function canCreateTrelloTicket(task, boards) {
  return Boolean(
    task?.projectId &&
    !task?.sourceUrl &&
    !task?.sourceProvider &&
    !task?.sourceKind &&
    boards?.length,
  );
}
