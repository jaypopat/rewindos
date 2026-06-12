import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";

function renderSidebar(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Sidebar", () => {
  it("renders all nav items grouped, plus settings", () => {
    const onViewChange = vi.fn();
    renderSidebar(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    // 4 Overview + 4 Think + pinned Settings + collapse toggle
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(10);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Think")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("calls onViewChange when a nav item is clicked", () => {
    const onViewChange = vi.fn();
    renderSidebar(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    fireEvent.click(screen.getByText("Search"));
    expect(onViewChange).toHaveBeenCalledWith("search");
  });

  it("highlights the active view with the accent mark", () => {
    const onViewChange = vi.fn();
    const { container } = renderSidebar(
      <Sidebar activeView="ask" onViewChange={onViewChange} />,
    );

    const indicator = container.querySelector(".animate-navmark");
    expect(indicator).toBeTruthy();
    const askButton = screen.getByText("Ask").closest("button");
    expect(askButton?.className).toContain("text-accent-hi");
  });

  it("navigates to settings from the pinned footer button", () => {
    const onViewChange = vi.fn();
    renderSidebar(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    fireEvent.click(screen.getByText("Settings"));
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });
});
