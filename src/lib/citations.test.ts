import { describe, it, expect } from "vitest";
import { parseTextWithRefs, collectRefs } from "./citations";

describe("parseTextWithRefs", () => {
  it("returns a single text segment for text with no refs", () => {
    expect(parseTextWithRefs("just plain text")).toEqual([
      { type: "text", text: "just plain text" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseTextWithRefs("")).toEqual([]);
  });

  it("splits around a single ref", () => {
    expect(parseTextWithRefs("before [REF:42] after")).toEqual([
      { type: "text", text: "before " },
      { type: "ref", id: 42 },
      { type: "text", text: " after" },
    ]);
  });

  it("handles consecutive refs with no text between", () => {
    expect(parseTextWithRefs("[REF:1][REF:2]")).toEqual([
      { type: "ref", id: 1 },
      { type: "ref", id: 2 },
    ]);
  });

  it("handles ref at start and end", () => {
    expect(parseTextWithRefs("[REF:1] middle [REF:2]")).toEqual([
      { type: "ref", id: 1 },
      { type: "text", text: " middle " },
      { type: "ref", id: 2 },
    ]);
  });

  it("ignores malformed markers", () => {
    expect(parseTextWithRefs("see [REF:abc] and [REF:] and [ref:5]")).toEqual([
      { type: "text", text: "see [REF:abc] and [REF:] and [ref:5]" },
    ]);
  });
});

describe("collectRefs", () => {
  it("collects unique ids in order of first appearance", () => {
    const parts = [
      { type: "text" as const, text: "x " },
      { type: "ref" as const, id: 42 },
      { type: "text" as const, text: " y " },
      { type: "ref" as const, id: 7 },
      { type: "text" as const, text: " z " },
      { type: "ref" as const, id: 42 },
    ];
    expect(collectRefs(parts)).toEqual([42, 7]);
  });

  it("returns empty for parts with no refs", () => {
    expect(collectRefs([{ type: "text", text: "plain" }])).toEqual([]);
  });
});
