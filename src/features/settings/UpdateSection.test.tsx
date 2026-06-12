import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@/lib/api", () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { checkForUpdate } from "@/lib/api";
import { UpdateSection } from "./UpdateSection";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("UpdateSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows up-to-date state", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: "1.0.8", latest: "v1.0.8", release_notes: "",
      available: false, installable: false,
    });
    render(<UpdateSection />, { wrapper });
    expect(await screen.findByText(/1\.0\.8/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).toBeNull();
  });

  it("shows install button when installable", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: "1.0.8", latest: "v1.0.9", release_notes: "## Notes",
      available: true, installable: true,
    });
    render(<UpdateSection />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /update now/i }),
    ).toBeInTheDocument();
  });

  it("shows rebuild copy for source builds", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: "1.0.8", latest: "v1.0.9", release_notes: "",
      available: true, installable: false,
    });
    render(<UpdateSection />, { wrapper });
    expect(await screen.findByText(/rebuild/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).toBeNull();
  });
});
