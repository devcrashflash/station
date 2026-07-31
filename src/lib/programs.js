export function normalizeProgramSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function programMatchScore(program, query) {
  const normalizedQuery = normalizeProgramSearch(query);
  if (!normalizedQuery) return 0;

  const normalizedName = normalizeProgramSearch(program?.name);
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;

  const queryTokens = normalizedQuery.split(" ");
  const nameTokens = normalizedName.split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
  if (queryTokens.every((queryToken) => nameTokens.some((nameToken) => nameToken.startsWith(queryToken)))) {
    return 2;
  }
  if (normalizedName.includes(normalizedQuery)) return 3;
  return null;
}

export function filterPrograms(programs, query = "") {
  return (programs || [])
    .map((program) => ({ program, score: programMatchScore(program, query) }))
    .filter(({ score }) => score !== null)
    .sort((left, right) => (
      left.score - right.score
      || left.program.name.localeCompare(right.program.name, undefined, { sensitivity: "base" })
      || left.program.id.localeCompare(right.program.id)
    ))
    .map(({ program }) => program);
}

export function highlightedProgramId(programs, currentId) {
  if (programs.some((program) => program.id === currentId)) return currentId;
  return programs[0]?.id || null;
}

export function movedProgramId(programs, currentId, direction) {
  if (programs.length === 0) return null;
  const currentIndex = programs.findIndex((program) => program.id === currentId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  return programs[(startIndex + direction + programs.length) % programs.length].id;
}

export function numberedProgram(programs, key, query = "") {
  if (normalizeProgramSearch(query) || !/^[1-9]$/.test(key)) return null;
  return programs[Number(key) - 1] || null;
}
