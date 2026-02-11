import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock Tauri APIs for testing
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => { })),
  emit: vi.fn(),
}));
