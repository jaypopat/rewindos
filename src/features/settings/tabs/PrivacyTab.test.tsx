import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ openAnalyticsDoc: vi.fn() }));

import { openAnalyticsDoc } from "@/lib/api";
import type { AppConfig } from "@/lib/config";
import { PrivacyTab } from "./PrivacyTab";

const config = {
  privacy: { excluded_apps: [], excluded_title_patterns: [], analytics: true },
} as unknown as AppConfig;

describe("PrivacyTab analytics switch", () => {
  it("turns analytics off through the shared update callback", () => {
    const update = vi.fn();
    render(<PrivacyTab config={config} update={update} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith("privacy", "analytics", false);
  });

  it("opens the analytics doc", () => {
    render(<PrivacyTab config={config} update={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "See everything that is sent" }));
    expect(openAnalyticsDoc).toHaveBeenCalled();
  });
});
