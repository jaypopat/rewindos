import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskEmptyState } from "./AskEmptyState";

describe("AskEmptyState", () => {
  it("renders the title", () => {
    render(<AskEmptyState onSuggest={vi.fn()} />);
    expect(screen.getByText("Ask RewindOS")).toBeTruthy();
  });

  it("renders all suggested questions", () => {
    render(<AskEmptyState onSuggest={vi.fn()} />);
    expect(screen.getByText("What was that error I saw in VS Code?")).toBeTruthy();
    expect(screen.getByText("What did I work on this morning?")).toBeTruthy();
    expect(screen.getByText("How long did I spend on GitHub today?")).toBeTruthy();
    expect(screen.getByText("Show me what I was reading last hour")).toBeTruthy();
  });

  it("calls onSuggest when a suggested question is clicked", () => {
    const onSuggest = vi.fn();
    render(<AskEmptyState onSuggest={onSuggest} />);

    fireEvent.click(screen.getByText("What did I work on this morning?"));
    expect(onSuggest).toHaveBeenCalledWith("What did I work on this morning?");
  });

  it("renders the memory interface label", () => {
    render(<AskEmptyState onSuggest={vi.fn()} />);
    expect(screen.getByText("memory interface")).toBeTruthy();
  });
});
