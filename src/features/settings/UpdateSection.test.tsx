import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

let progressHandler: ((e: { payload: unknown }) => void) | null = null;

vi.mock("@/lib/api", () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_evt: string, cb: (e: { payload: unknown }) => void) => {
    progressHandler = cb;
    return Promise.resolve(() => {
      progressHandler = null;
    });
  }),
}));

import { checkForUpdate, installUpdate, restartApp } from "@/lib/api";
import { UpdateSection } from "./UpdateSection";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const installableStatus = {
  current: "1.0.8",
  latest: "v1.0.9",
  release_notes: "",
  available: true,
  installable: true,
};

/** Resolves on the next microtask tick — lets promises and effects settle. */
const tick = () => act(() => Promise.resolve());

describe("UpdateSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressHandler = null;
  });

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

  it("shows progress events while installing", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(installableStatus);
    // installUpdate never resolves — simulates in-progress download
    (installUpdate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    render(<UpdateSection />, { wrapper });
    const btn = await screen.findByRole("button", { name: /update now/i });
    fireEvent.click(btn);

    // Let the effect run so the listener is registered
    await tick();

    act(() => {
      progressHandler?.({ payload: { stage: "downloading", pct: 40 } });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/Downloading… 40%/);
  });

  it("error event ends install with a single error line and allows retry", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(installableStatus);
    (installUpdate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    render(<UpdateSection />, { wrapper });
    const btn = await screen.findByRole("button", { name: /update now/i });
    fireEvent.click(btn);

    await tick();

    act(() => {
      progressHandler?.({ payload: { stage: "error", message: "boom" } });
    });

    // Error rendered exactly once via role="alert"
    const alerts = screen.getAllByRole("alert");
    const errorAlerts = alerts.filter((el) => el.textContent?.includes("boom"));
    expect(errorAlerts).toHaveLength(1);

    // Retry button is back
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
  });

  it("done event shows restart button", async () => {
    (checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(installableStatus);
    (installUpdate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (restartApp as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    render(<UpdateSection />, { wrapper });
    const btn = await screen.findByRole("button", { name: /update now/i });
    fireEvent.click(btn);

    await tick();

    act(() => {
      progressHandler?.({ payload: { stage: "done" } });
    });

    const restartBtn = screen.getByRole("button", { name: /restart rewindos to finish/i });
    expect(restartBtn).toBeInTheDocument();

    fireEvent.click(restartBtn);
    expect(restartApp).toHaveBeenCalledOnce();
  });
});
