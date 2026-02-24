import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("renders all main nav items plus settings", () => {
    const onViewChange = vi.fn();
    render(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    const buttons = screen.getAllByRole("button");
    // 8 nav items + 1 settings button = 9
    expect(buttons.length).toBe(9);
  });

  it("calls onViewChange when a nav item is clicked", () => {
    const onViewChange = vi.fn();
    render(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    const buttons = screen.getAllByRole("button");
    // Click the fourth button (Search — after Today, History, Rewind)
    fireEvent.click(buttons[3]);
    expect(onViewChange).toHaveBeenCalledWith("search");
  });

  it("highlights the active view", () => {
    const onViewChange = vi.fn();
    const { container } = render(
      <Sidebar activeView="ask" onViewChange={onViewChange} />,
    );

    // The active indicator span should exist for the ask view
    const indicator = container.querySelector(".bg-semantic");
    expect(indicator).toBeTruthy();
  });

  it("renders settings button at the bottom", () => {
    const onViewChange = vi.fn();
    render(<Sidebar activeView="dashboard" onViewChange={onViewChange} />);

    const buttons = screen.getAllByRole("button");
    const lastButton = buttons[buttons.length - 1];
    fireEvent.click(lastButton);
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });
});
