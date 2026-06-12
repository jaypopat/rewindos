import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@/lib/api", () => ({ checkForUpdate: vi.fn() }));

import { checkForUpdate } from "@/lib/api";
import { UpdateToast, NOTIFIED_KEY } from "./UpdateToast";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const AVAILABLE = {
  current: "1.0.8", latest: "v1.0.9", release_notes: "",
  available: true, install_kind: "script",
};

describe("UpdateToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows when an update is available and not yet notified", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(AVAILABLE);
    render(<UpdateToast onOpenSettings={() => {}} />, { wrapper });
    expect(await screen.findByText(/v1\.0\.9/)).toBeInTheDocument();
  });

  it("stays hidden when already notified for this tag", async () => {
    localStorage.setItem(NOTIFIED_KEY, "v1.0.9");
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(AVAILABLE);
    const { container } = render(<UpdateToast onOpenSettings={() => {}} />, { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it("dismiss records the tag; View opens settings and dismisses", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(AVAILABLE);
    const onOpen = vi.fn();
    render(<UpdateToast onOpenSettings={onOpen} />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /view/i }));
    expect(onOpen).toHaveBeenCalled();
    expect(localStorage.getItem(NOTIFIED_KEY)).toBe("v1.0.9");
    expect(screen.queryByText(/v1\.0\.9/)).toBeNull();
  });

  it("stays hidden when up to date (available: false)", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: "1.0.9", latest: "v1.0.9", release_notes: "",
      available: false, install_kind: "script",
    });
    const { container } = render(<UpdateToast onOpenSettings={() => {}} />, { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
