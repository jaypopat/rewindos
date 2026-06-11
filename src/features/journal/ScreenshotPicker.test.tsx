import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  browseScreenshots: vi.fn(),
  search: vi.fn(),
  getImageUrl: (p: string) => p,
}));

import { browseScreenshots } from "@/lib/api";
import { ScreenshotPicker } from "./ScreenshotPicker";

const PAGE_SIZE = 50;

function makeEntries(startId: number, count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    timestamp: 1700000000 + startId + i,
    app_name: "firefox",
    window_title: "tab",
    thumbnail_path: `/thumb/${startId + i}.webp`,
    file_path: `/full/${startId + i}.webp`,
  }));
}

function renderPicker(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ScreenshotPicker
        dayStart={0}
        dayEnd={86400}
        attachedIds={[]}
        onAttach={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

// Images render with alt="" (role "presentation"), so count them directly.
function imgCount(container: HTMLElement) {
  return container.querySelectorAll("img").length;
}

describe("ScreenshotPicker accumulation", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  it("does not duplicate rows when a loaded page is refetched", async () => {
    const page0 = makeEntries(1, PAGE_SIZE);
    const page1 = makeEntries(PAGE_SIZE + 1, 10);
    vi.mocked(browseScreenshots).mockImplementation(
      async (_s, _e, _app, _limit, offset) => (offset === 0 ? page0 : page1),
    );

    const { container } = renderPicker(client);
    await waitFor(() => expect(imgCount(container)).toBe(PAGE_SIZE));

    fireEvent.click(screen.getByText("load more"));
    await waitFor(() => expect(imgCount(container)).toBe(PAGE_SIZE + 10));

    // A refetch (invalidation / window focus / strict mode) re-runs every
    // active queryFn. Accumulated rows must not double. (type: "active"
    // matches window-focus behavior; an unfiltered refetch would also re-run
    // the inactive offset-0 query, whose replace would mask the duplication.)
    await act(async () => {
      await client.refetchQueries({ type: "active" });
    });
    await waitFor(() => expect(imgCount(container)).toBe(PAGE_SIZE + 10));
  });
});
