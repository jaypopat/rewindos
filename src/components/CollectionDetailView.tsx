import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getCollectionScreenshots,
  getImageUrl,
  listCollections,
  removeFromCollection,
  deleteCollection,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { BookmarkButton } from "./BookmarkButton";
import { AppDot } from "./AppDot";
import { formatRelativeTime } from "@/lib/format";
import { ArrowLeft, Clock, Trash2, X, ImageIcon } from "lucide-react";

interface CollectionDetailViewProps {
  collectionId: number;
  onBack: () => void;
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

export function CollectionDetailView({
  collectionId,
  onBack,
  onSelectScreenshot,
}: CollectionDetailViewProps) {
  const queryClient = useQueryClient();

  const { data: collections = [] } = useQuery({
    queryKey: queryKeys.collections(),
    queryFn: listCollections,
  });

  const collection = collections.find((c) => c.id === collectionId);

  const { data: screenshots = [], isLoading } = useQuery({
    queryKey: queryKeys.collectionScreenshots(collectionId),
    queryFn: () => getCollectionScreenshots(collectionId),
  });

  const removeMutation = useMutation({
    mutationFn: (screenshotId: number) => removeFromCollection(collectionId, screenshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collectionScreenshots(collectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCollection(collectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      onBack();
    },
  });

  const allIds = screenshots.map((s) => s.id);

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="text-text-secondary hover:text-text-primary -ml-2"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>

        <div className="w-px h-4 bg-border/50" />

        {collection && (
          <>
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: collection.color }}
            />
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-medium text-text-primary truncate">{collection.name}</h2>
              {collection.description && (
                <p className="text-xs text-text-muted truncate">{collection.description}</p>
              )}
            </div>
            {collection.start_time && collection.end_time && (
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Clock className="size-3" strokeWidth={1.5} />
                Time range
              </div>
            )}
            <span className="text-xs text-text-muted font-mono">
              {screenshots.length} screenshot{screenshots.length !== 1 ? "s" : ""}
            </span>
          </>
        )}

        <div className="ml-auto">
          <button
            onClick={() => {
              if (collection && confirm(`Delete collection "${collection.name}"?`)) {
                deleteMutation.mutate();
              }
            }}
            className="p-1.5 text-text-muted hover:text-red-400 transition-colors"
            title="Delete collection"
          >
            <Trash2 className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : screenshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2">
          <p className="text-sm text-text-muted">No screenshots in this collection</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            {screenshots.map((entry) => (
              <div
                key={entry.id}
                className="group relative overflow-hidden bg-surface-raised border border-border/30 hover:border-accent/30 transition-all cursor-pointer text-left"
              >
                <button
                  onClick={() => onSelectScreenshot?.(entry.id, allIds)}
                  className="w-full"
                >
                  <div className="aspect-video bg-surface-overlay relative">
                    {entry.thumbnail_path ? (
                      <img
                        src={getImageUrl(entry.thumbnail_path)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-text-muted">
                        <ImageIcon className="size-8 opacity-30" strokeWidth={1} />
                      </div>
                    )}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface/95 via-surface/70 to-transparent p-3 pt-8">
                    <div className="flex items-center gap-1.5 mb-1">
                      {entry.app_name && (
                        <>
                          <AppDot appName={entry.app_name} size={6} />
                          <span className="text-[10px] font-mono text-text-secondary truncate">
                            {entry.app_name}
                          </span>
                        </>
                      )}
                      <span className="text-[10px] text-text-muted ml-auto shrink-0">
                        {formatRelativeTime(entry.timestamp)}
                      </span>
                    </div>
                    {entry.window_title && (
                      <p className="text-xs text-text-primary truncate leading-tight">
                        {entry.window_title}
                      </p>
                    )}
                  </div>
                </button>

                {/* Hover actions */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <BookmarkButton screenshotId={entry.id} />
                  {/* Only show remove for manual collections (no time-range) */}
                  {collection && !collection.start_time && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeMutation.mutate(entry.id);
                      }}
                      className="text-text-muted hover:text-red-400 transition-colors"
                      title="Remove from collection"
                    >
                      <X className="size-3.5" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
