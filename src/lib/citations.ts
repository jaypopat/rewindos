export type TextPart =
  | { type: "text"; text: string }
  | { type: "ref"; id: number };

const REF_RE = /\[REF:(\d+)\]/g;

export function parseTextWithRefs(text: string): TextPart[] {
  if (text === "") return [];
  const out: TextPart[] = [];
  let cursor = 0;
  const re = new RegExp(REF_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      out.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    out.push({ type: "ref", id: Number(match[1]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    out.push({ type: "text", text: text.slice(cursor) });
  }
  return out;
}

export function collectRefs(parts: TextPart[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of parts) {
    if (p.type === "ref" && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p.id);
    }
  }
  return out;
}
