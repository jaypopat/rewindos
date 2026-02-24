import { describe, it, expect } from "vitest";
import { queryKeys } from "./query-keys";

describe("queryKeys", () => {
  it("generates unique search keys based on query and filters", () => {
    const filters = { limit: 50, offset: 0 };
    const key1 = queryKeys.search("hello", filters);
    const key2 = queryKeys.search("world", filters);
    expect(key1).not.toEqual(key2);
    expect(key1[0]).toBe("search");
    expect(key1[1]).toBe("hello");
  });

  it("generates screenshot key from id", () => {
    const key = queryKeys.screenshot(42);
    expect(key).toEqual(["screenshot", 42]);
  });

  it("generates stable daemon status key", () => {
    expect(queryKeys.daemonStatus()).toEqual(["daemon-status"]);
  });

  it("generates stable app names key", () => {
    expect(queryKeys.appNames()).toEqual(["app-names"]);
  });

  it("generates activity key from timestamp", () => {
    const key = queryKeys.activity(1000);
    expect(key).toEqual(["activity", 1000, undefined]);
  });

  it("generates activity key with until timestamp", () => {
    const key = queryKeys.activity(1000, 2000);
    expect(key).toEqual(["activity", 1000, 2000]);
  });

  it("generates ask health key", () => {
    expect(queryKeys.askHealth()).toEqual(["ask-health"]);
  });
});
