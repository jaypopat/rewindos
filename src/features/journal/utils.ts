/**
 * Extract unchecked todo texts from Tiptap JSON content.
 * Walks the document tree for `taskItem` nodes with `attrs.checked === false`.
 */
export function extractUncheckedTodos(content: string): string[] {
  try {
    const doc = JSON.parse(content);
    const todos: string[] = [];
    walkForUnchecked(doc, todos);
    return todos;
  } catch {
    return [];
  }
}

function walkForUnchecked(node: any, out: string[]): void {
  if (node.type === "taskItem" && node.attrs?.checked === false) {
    const text = collectText(node).trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walkForUnchecked(child, out);
    }
  }
}

function collectText(node: any): string {
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    return node.content.map(collectText).join("");
  }
  return "";
}

/**
 * Build Tiptap JSON content for carried-forward todos.
 */
export function buildCarryForwardContent(todos: string[]): string {
  if (todos.length === 0) return "";

  const taskItems = todos.map((text) => ({
    type: "taskItem",
    attrs: { checked: false },
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  }));

  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            marks: [{ type: "bold" }],
            text: "Carried forward",
          },
        ],
      },
      {
        type: "taskList",
        content: taskItems,
      },
    ],
  };

  return JSON.stringify(doc);
}
