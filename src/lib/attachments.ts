const RE = /^\[ATTACH:(\d+(?:,\d+)*)\]\n\n/;

export interface DecodedMessage {
  ids: number[];
  text: string;
}

export function encodeAttachments(ids: number[], text: string): string {
  if (ids.length === 0) return text;
  return `[ATTACH:${ids.join(",")}]\n\n${text}`;
}

export function decodeAttachments(raw: string): DecodedMessage {
  const m = raw.match(RE);
  if (!m) return { ids: [], text: raw };
  const ids = m[1].split(",").map((s) => Number(s));
  return { ids, text: raw.slice(m[0].length) };
}

export function stripMarker(raw: string): string {
  return raw.replace(RE, "");
}

export function hasAttachments(raw: string): boolean {
  return RE.test(raw);
}
