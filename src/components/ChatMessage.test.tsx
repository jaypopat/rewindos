import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMessage } from "./ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/hooks/useAskStream";

// Mock the format module to avoid time-dependent output
vi.mock("@/lib/format", () => ({
  formatRelativeTime: (ts: number) => `${ts}s ago`,
}));

// Mock the API module
vi.mock("@/lib/api", () => ({
  getImageUrl: (path: string) => `asset://localhost/${path}`,
}));

describe("ChatMessage", () => {
  it("renders user messages with 'you' label", () => {
    const msg: ChatMessageType = {
      role: "user",
      content: "What did I work on today?",
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("you")).toBeTruthy();
    expect(screen.getByText("What did I work on today?")).toBeTruthy();
  });

  it("renders assistant messages with 'rewindos' label", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "You worked on the chat feature.",
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("rewindos")).toBeTruthy();
  });

  it("shows streaming cursor when isStreaming is true", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "Thinking...",
    };

    const { container } = render(
      <ChatMessage message={msg} isStreaming={true} />,
    );
    const cursor = container.querySelector(".typing-cursor");
    expect(cursor).toBeTruthy();
  });

  it("does not show streaming cursor when isStreaming is false", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "Done.",
    };

    const { container } = render(
      <ChatMessage message={msg} isStreaming={false} />,
    );
    const cursor = container.querySelector(".typing-cursor");
    expect(cursor).toBeNull();
  });

  it("parses [REF:ID] markers as clickable refs", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "I found this error [REF:42] in your VS Code session.",
      references: [
        {
          id: 42,
          timestamp: 1000,
          app_name: "VS Code",
          window_title: "main.rs",
          file_path: "/screenshots/42.webp",
        },
      ],
    };

    const onClick = vi.fn();
    render(<ChatMessage message={msg} onScreenshotClick={onClick} />);

    // The ref card should render with the app name
    expect(screen.getByText("VS Code")).toBeTruthy();
  });

  it("renders [REF:ID] as inline link when no matching reference", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "Check out [REF:99].",
      references: [],
    };

    const onClick = vi.fn();
    render(<ChatMessage message={msg} onScreenshotClick={onClick} />);

    const refLink = screen.getByText("[#99]");
    expect(refLink).toBeTruthy();

    fireEvent.click(refLink);
    expect(onClick).toHaveBeenCalledWith(99);
  });

  it("renders unreferenced screenshots as sources at the bottom", () => {
    const msg: ChatMessageType = {
      role: "assistant",
      content: "You were using VS Code this morning.",
      references: [
        {
          id: 1,
          timestamp: 1000,
          app_name: "VS Code",
          window_title: "app.tsx",
          file_path: "/screenshots/1.webp",
        },
      ],
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("sources")).toBeTruthy();
  });
});
