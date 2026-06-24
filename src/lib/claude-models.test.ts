import { describe, it, expect } from "vitest";
import { isClaudeModel, resolveChatRoute } from "./claude-models";

describe("isClaudeModel", () => {
  it("recognizes the Claude aliases", () => {
    expect(isClaudeModel("opus")).toBe(true);
    expect(isClaudeModel("sonnet")).toBe(true);
    expect(isClaudeModel("haiku")).toBe(true);
  });

  it("treats Ollama model names as non-Claude", () => {
    expect(isClaudeModel("qwen2.5:3b")).toBe(false);
    expect(isClaudeModel("llama3.2")).toBe(false);
  });

  it("handles null/empty", () => {
    expect(isClaudeModel(null)).toBe(false);
    expect(isClaudeModel(undefined)).toBe(false);
    expect(isClaudeModel("")).toBe(false);
  });
});

describe("resolveChatRoute", () => {
  const ollamaDefaultModel = "qwen2.5:7b";

  it("routes an explicitly selected Ollama model to Ollama even when Claude is ready", () => {
    const route = resolveChatRoute({
      selectedModel: "qwen2.5:3b",
      claudeReady: true,
      ollamaDefaultModel,
    });
    expect(route).toEqual({ provider: "ollama", model: "qwen2.5:3b", mode: "prebuilt" });
  });

  it("routes an explicitly selected Claude model to Claude", () => {
    const route = resolveChatRoute({
      selectedModel: "opus",
      claudeReady: true,
      ollamaDefaultModel,
    });
    expect(route).toEqual({ provider: "claude", model: "opus", mode: "prebuilt" });
  });

  it("defaults to Claude (sonnet) when nothing is selected and Claude is ready", () => {
    const route = resolveChatRoute({
      selectedModel: null,
      claudeReady: true,
      ollamaDefaultModel,
    });
    expect(route).toEqual({ provider: "claude", model: "sonnet", mode: "prebuilt" });
  });

  it("defaults to the Ollama config model when nothing is selected and Claude is not ready", () => {
    const route = resolveChatRoute({
      selectedModel: null,
      claudeReady: false,
      ollamaDefaultModel,
    });
    expect(route).toEqual({ provider: "ollama", model: ollamaDefaultModel, mode: "prebuilt" });
  });

  it("still honors an explicit Claude pick when Claude is not ready (caller surfaces the error)", () => {
    const route = resolveChatRoute({
      selectedModel: "sonnet",
      claudeReady: false,
      ollamaDefaultModel,
    });
    expect(route).toEqual({ provider: "claude", model: "sonnet", mode: "prebuilt" });
  });
});

describe("resolveChatRoute mode", () => {
  it("ollama + agentic flag on → agentic mode", () => {
    const r = resolveChatRoute({
      selectedModel: "llama3.1", claudeReady: false,
      ollamaDefaultModel: "llama3.1", agenticTools: true,
    });
    expect(r).toMatchObject({ provider: "ollama", mode: "agentic" });
  });

  it("ollama + agentic flag off → prebuilt mode", () => {
    const r = resolveChatRoute({
      selectedModel: "llama3.1", claudeReady: false,
      ollamaDefaultModel: "llama3.1", agenticTools: false,
    });
    expect(r).toMatchObject({ provider: "ollama", mode: "prebuilt" });
  });

  it("claude provider is unaffected by agentic flag", () => {
    const r = resolveChatRoute({
      selectedModel: "sonnet", claudeReady: true,
      ollamaDefaultModel: "llama3.1", agenticTools: true,
    });
    expect(r.provider).toBe("claude");
  });
});
