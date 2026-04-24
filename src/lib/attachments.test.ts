import { describe, it, expect } from "vitest";
import {
  encodeAttachments,
  decodeAttachments,
  stripMarker,
  hasAttachments,
} from "./attachments";

describe("attachments marker", () => {
  it("encodes ids as a prefix", () => {
    expect(encodeAttachments([42, 43], "what was I doing?")).toBe(
      "[ATTACH:42,43]\n\nwhat was I doing?",
    );
  });

  it("returns raw text when no ids", () => {
    expect(encodeAttachments([], "hello")).toBe("hello");
  });

  it("decodes a well-formed marker", () => {
    expect(decodeAttachments("[ATTACH:42,43]\n\nhi")).toEqual({
      ids: [42, 43],
      text: "hi",
    });
  });

  it("returns empty ids for text with no marker", () => {
    expect(decodeAttachments("plain text")).toEqual({
      ids: [],
      text: "plain text",
    });
  });

  it("stripMarker + hasAttachments edge cases", () => {
    expect(stripMarker("[ATTACH:1]\n\nhi")).toBe("hi");
    expect(stripMarker("no marker")).toBe("no marker");
    expect(hasAttachments("[ATTACH:1,2]\n\nhi")).toBe(true);
    expect(hasAttachments("hi")).toBe(false);
  });
});
