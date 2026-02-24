import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listBookmarks,
  listCollections,
  createCollection,
  deleteCollection,
  getImageUrl,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { BookmarkButton } from "@/components/BookmarkButton";
import { CollectionDetailView } from "./CollectionDetailView";
import { AppDot } from "@/components/AppDot";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Plus, Clock, Trash2, ImageIcon } from "lucide-react";

type SavedTab = "bookmarks" | "collections";

interface SavedViewProps {
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

export function SavedView({ onSelectScreenshot }: SavedViewProps) {
  const [tab, setTab] = useState<SavedTab>("bookmarks");
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const queryClient = useQueryClient();

  const { data: bookmarks = [], isLoading: loadingBookmarks } = useQuery({
    queryKey: queryKeys.bookmarks(),
    queryFn: () => listBookmarks(),
    enabled: tab === "bookmarks",
  });

  const { data: collections = [], isLoading: loadingCollections } = useQuery({
    queryKey: queryKeys.collections(),
    queryFn: listCollections,
    enabled: tab === "collections",
  });

  const deleteMutation = useMutation({
    mutationFn: deleteCollection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      return createCollection({ name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      setShowNewCollection(false);
      setNewCollectionName("");
    },
  });

  // Show collection detail if one is selected
  if (selectedCollectionId !== null) {
    return (
      <CollectionDetailView
        collectionId={selectedCollectionId}
        onBack={() => setSelectedCollectionId(null)}
        onSelectScreenshot={onSelectScreenshot}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl text-text-primary">Saved</h2>
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {(["bookmarks", "collections"] as const).map((t) => (
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
        {tab === "collections" && (
          <button
            onClick={() => setShowNewCollection(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors"
          >
            <Plus className="size-3" strokeWidth={2} />
            New Collection
          </button>
        )}
      </div>

      {/* Bookmarks tab */}
      {tab === "bookmarks" && (
        <div className="flex-1 overflow-y-auto">
          {loadingBookmarks ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : bookmarks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <p className="text-sm text-text-muted">No bookmarks yet</p>
              <p className="text-xs text-text-muted">Star a screenshot to save it here</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
              {bookmarks.map((entry) => (
                <button
                  key={entry.bookmark.id}
                  onClick={() => {
                    const ids = bookmarks.map((b) => b.screenshot.id);
                    onSelectScreenshot?.(entry.screenshot.id, ids);
                  }}
                  className="group relative overflow-hidden bg-surface-raised border border-border/30 hover:border-accent/30 transition-all cursor-pointer text-left"
                >
                  <div className="aspect-video bg-surface-overlay relative">
                    {entry.screenshot.thumbnail_path ? (
                      <img
                        src={getImageUrl(entry.screenshot.thumbnail_path)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-text-muted">
                        <ImageIcon className="size-8 opacity-30" strokeWidth={1} />
                      </div>
                    )}
                    {/* Bookmark button overlay */}
                    <div className="absolute top-1.5 right-1.5">
                      <BookmarkButton screenshotId={entry.screenshot.id} />
                    </div>
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface/95 via-surface/70 to-transparent p-3 pt-8">
                    <div className="flex items-center gap-1.5 mb-1">
                      {entry.screenshot.app_name && (
                        <>
                          <AppDot appName={entry.screenshot.app_name} size={6} />
                          <span className="text-[10px] font-mono text-text-secondary truncate">
                            {entry.screenshot.app_name}
                          </span>
                        </>
                      )}
                      <span className="text-[10px] text-text-muted ml-auto shrink-0">
                        {formatRelativeTime(entry.screenshot.timestamp)}
                      </span>
                    </div>
                    {entry.screenshot.window_title && (
                      <p className="text-xs text-text-primary truncate leading-tight">
                        {entry.screenshot.window_title}
                      </p>
                    )}
                    {entry.bookmark.note && (
                      <p className="text-[10px] text-text-muted truncate mt-0.5">
                        {entry.bookmark.note}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collections tab */}
      {tab === "collections" && (
        <div className="flex-1 overflow-y-auto">
          {/* New collection inline form */}
          {showNewCollection && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newCollectionName.trim()) createMutation.mutate(newCollectionName.trim());
              }}
              className="flex items-center gap-3 px-4 py-3 mb-3 bg-surface-raised border border-accent/30 rounded-lg"
            >
              <input
                autoFocus
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Collection name..."
                className="flex-1 text-sm bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none"
              />
              <button
                type="button"
                onClick={() => { setShowNewCollection(false); setNewCollectionName(""); }}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newCollectionName.trim() || createMutation.isPending}
                className="text-xs text-accent hover:text-accent/80 font-medium disabled:opacity-40 transition-colors"
              >
                Create
              </button>
            </form>
          )}

          {loadingCollections ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : collections.length === 0 && !showNewCollection ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <p className="text-sm text-text-muted">No collections yet</p>
              <p className="text-xs text-text-muted">Create one to organize your screenshots</p>
            </div>
          ) : (
            <div className="space-y-2">
              {collections.map((col) => (
                <div
                  key={col.id}
                  className="flex items-center gap-3 px-4 py-3 bg-surface-raised border border-border/30 hover:border-accent/30 rounded-lg transition-all group"
                >
                  <button
                    onClick={() => setSelectedCollectionId(col.id)}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: col.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text-primary font-medium truncate">
                          {col.name}
                        </span>
                        <span className="text-[10px] text-text-muted font-mono">
                          {col.screenshot_count} screenshot{col.screenshot_count !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {col.description && (
                        <p className="text-xs text-text-muted truncate">{col.description}</p>
                      )}
                      {col.start_time && col.end_time && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Clock className="size-2.5 text-text-muted" strokeWidth={1.5} />
                          <span className="text-[10px] text-text-muted">
                            Time range collection
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete collection "${col.name}"?`)) {
                        deleteMutation.mutate(col.id);
                      }
                    }}
                    className="p-1.5 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
