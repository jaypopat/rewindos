import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listBookmarks,
  listCollections,
  deleteCollection,
  updateCollection,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { BookmarkButton } from "@/components/BookmarkButton";
import { CollectionDetailView } from "./CollectionDetailView";
import { SaveMomentDialog } from "./SaveMomentDialog";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { EmptyState } from "@/components/shared/EmptyState";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { ScreenshotCard } from "@/components/shared/ScreenshotCard";
import { formatMomentDate, formatMomentTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Plus, Clock, Trash2, Pencil, Search } from "lucide-react";

type SavedTab = "favorites" | "moments";

interface SavedViewProps {
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
  onRewindToRange?: (start: number, end: number) => void;
}

export function SavedView({ onSelectScreenshot, onRewindToRange }: SavedViewProps) {
  const [tab, setTab] = useState<SavedTab>("favorites");
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [showNewMoment, setShowNewMoment] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [momentSearch, setMomentSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: bookmarks = [], isLoading: loadingBookmarks } = useQuery({
    queryKey: queryKeys.bookmarks(),
    queryFn: () => listBookmarks(),
    enabled: tab === "favorites",
  });

  const { data: collections = [], isLoading: loadingCollections } = useQuery({
    queryKey: queryKeys.collections(),
    queryFn: listCollections,
    enabled: tab === "moments",
  });

  const moments = collections.filter((c) => c.start_time && c.end_time);

  const filteredMoments = momentSearch.trim()
    ? moments.filter((m) => {
        const q = momentSearch.toLowerCase();
        return (
          m.name.toLowerCase().includes(q) ||
          (m.description && m.description.toLowerCase().includes(q))
        );
      })
    : moments;

  const deleteMutation = useMutation({
    mutationFn: deleteCollection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      setConfirmDeleteId(null);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      updateCollection(id, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      setRenamingId(null);
    },
  });

  // Show collection detail if one is selected
  if (selectedCollectionId !== null) {
    return (
      <CollectionDetailView
        collectionId={selectedCollectionId}
        onBack={() => setSelectedCollectionId(null)}
        onSelectScreenshot={onSelectScreenshot}
        onRewindToRange={onRewindToRange}
      />
    );
  }

  const momentToDelete = confirmDeleteId !== null
    ? moments.find((m) => m.id === confirmDeleteId)
    : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl text-text-primary">Saved</h2>
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {(["favorites", "moments"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md transition-colors capitalize",
                  t === tab
                    ? "bg-accent/15 text-accent font-medium"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {tab === "moments" && (
          <button
            onClick={() => setShowNewMoment(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors"
          >
            <Plus className="size-3" strokeWidth={2} />
            New Moment
          </button>
        )}
      </div>

      {/* Favorites tab */}
      {tab === "favorites" && (
        <div className="flex-1 overflow-y-auto">
          {loadingBookmarks ? (
            <div className="flex items-center justify-center py-20">
              <LoadingSpinner size="lg" />
            </div>
          ) : bookmarks.length === 0 ? (
            <EmptyState title="No favorites yet" description="Star a screenshot to save it here" />
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
              {bookmarks.map((entry) => (
                <ScreenshotCard
                  key={entry.bookmark.id}
                  screenshot={entry.screenshot}
                  onClick={() => {
                    const ids = bookmarks.map((b) => b.screenshot.id);
                    onSelectScreenshot?.(entry.screenshot.id, ids);
                  }}
                  actions={<BookmarkButton screenshotId={entry.screenshot.id} />}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Moments tab */}
      {tab === "moments" && (
        <div className="flex-1 overflow-y-auto">
          {loadingCollections ? (
            <div className="flex items-center justify-center py-20">
              <LoadingSpinner size="lg" />
            </div>
          ) : moments.length === 0 ? (
            <EmptyState icon={Clock} title="No moments saved" description="Save a time range to revisit it later" />
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-text-muted" strokeWidth={1.5} />
                <input
                  type="text"
                  value={momentSearch}
                  onChange={(e) => setMomentSearch(e.target.value)}
                  placeholder="Search moments..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-raised border border-border/30 rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 transition-colors"
                />
              </div>
              {filteredMoments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-text-muted">
                  <Search className="size-5 mb-2 opacity-40" strokeWidth={1.5} />
                  <p className="text-xs">No moments matching "{momentSearch}"</p>
                </div>
              ) : (
              <>
              {momentSearch.trim() && (
                <p className="text-[10px] text-text-muted px-1">
                  {filteredMoments.length} of {moments.length} moment{moments.length !== 1 ? "s" : ""}
                </p>
              )}
              {filteredMoments.map((col) => (
                <div
                  key={col.id}
                  className="flex items-center gap-3 px-4 py-3 bg-surface-raised border border-border/30 hover:border-accent/30 rounded-lg transition-all group"
                >
                  <button
                    onClick={() => renamingId !== col.id && setSelectedCollectionId(col.id)}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 shrink-0">
                      <Clock className="size-4 text-accent" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1 min-w-0">
                      {renamingId === col.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (renameValue.trim()) {
                              renameMutation.mutate({ id: col.id, name: renameValue.trim() });
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-2"
                        >
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => setRenamingId(null)}
                            onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                            className="flex-1 text-sm bg-transparent border border-accent/40 rounded px-2 py-0.5 text-text-primary focus:outline-none focus:border-accent"
                          />
                        </form>
                      ) : (
                        <span className="text-sm text-text-primary font-medium truncate block">
                          {col.name}
                        </span>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-text-muted">
                          {formatMomentDate(col.start_time!)}
                        </span>
                        <span className="text-[10px] text-text-secondary font-mono">
                          {formatMomentTime(col.start_time!)} – {formatMomentTime(col.end_time!)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono bg-accent/10 text-accent rounded">
                        {formatDuration(col.end_time! - col.start_time!)}
                      </span>
                      <span className="text-[10px] text-text-muted font-mono">
                        {col.screenshot_count} screenshot{col.screenshot_count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(col.id);
                      setRenameValue(col.name);
                    }}
                    className="p-1.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-all"
                    title="Rename moment"
                  >
                    <Pencil className="size-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(col.id);
                    }}
                    className="p-1.5 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Save Moment Dialog */}
      {showNewMoment && <SaveMomentDialog onClose={() => setShowNewMoment(false)} />}

      {/* Confirm Delete Dialog */}
      {confirmDeleteId !== null && (
        <ConfirmDialog
          title="Delete moment"
          description={<>Are you sure you want to delete <strong>"{momentToDelete?.name}"</strong>? This cannot be undone.</>}
          confirmLabel="Delete moment"
          cancelLabel="Cancel"
          destructive
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
