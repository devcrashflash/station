export function filterProjectChoices(projects = [], query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return projects;
  return projects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery));
}

export function cycleProjectIndex(currentIndex, choiceCount, direction = 1) {
  if (!Number.isInteger(choiceCount) || choiceCount <= 0) return -1;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= choiceCount) {
    return direction < 0 ? choiceCount - 1 : 0;
  }
  return (currentIndex + (direction < 0 ? -1 : 1) + choiceCount) % choiceCount;
}
