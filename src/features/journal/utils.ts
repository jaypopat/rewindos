/**
 * Extract unchecked todo lines from markdown content.
 * Matches lines like `- [ ] some task text`.
 */
export function extractUncheckedTodos(content: string): string[] {
  const todos: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [ ] ")) {
      const text = trimmed.slice(6).trim();
      if (text) todos.push(text);
    }
  }
  return todos;
}

/**
 * Build markdown content for carried-forward todos.
 */
export function buildCarryForwardContent(todos: string[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((t) => `- [ ] ${t}`);
  return `**Carried forward**\n\n${lines.join("\n")}\n\n`;
}
