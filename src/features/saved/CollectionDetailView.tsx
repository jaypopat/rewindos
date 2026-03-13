import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getCollectionScreenshots,
  listCollections,
  deleteCollection,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { BookmarkButton } from "@/components/BookmarkButton";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { EmptyState } from "@/components/shared/EmptyState";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { ScreenshotCard } from "@/components/shared/ScreenshotCard";
import { formatMomentRange, formatDuration } from "@/lib/format";
import { ArrowLeft, Clock, Rewind, Trash2 } from "lucide-react";

interface CollectionDetailViewProps {
  collectionId: number;
  onBack: () => void;
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
  onRewindToRange?: (start: number, end: number) => void;
}

export function CollectionDetailView({
  collectionId,
  onBack,
  onSelectScreenshot,
  onRewindToRange,
}: CollectionDetailViewProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
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
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 text-xs text-text-secondary">
                  <Clock className="size-3 text-accent" strokeWidth={1.5} />
                  {formatMomentRange(collection.start_time, collection.end_time)}
                </div>
                <span className="px-1.5 py-0.5 text-[10px] font-mono bg-accent/10 text-accent rounded">
                  {formatDuration(collection.end_time - collection.start_time)}
                </span>
                {onRewindToRange && (
                  <button
                    onClick={() => onRewindToRange(collection.start_time!, collection.end_time!)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded-md transition-colors"
                    title="Rewind this moment"
                  >
                    <Rewind className="size-3" strokeWidth={1.5} />
                    Rewind
                  </button>
                )}
              </div>
            )}
            <span className="text-xs text-text-muted font-mono">
              {screenshots.length} screenshot{screenshots.length !== 1 ? "s" : ""}
            </span>
          </>
        )}

        <div className="ml-auto">
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 text-text-muted hover:text-red-400 transition-colors"
            title="Delete moment"
          >
            <Trash2 className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : screenshots.length === 0 ? (
        <EmptyState title="No screenshots in this moment" />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            {screenshots.map((entry) => (
              <ScreenshotCard
                key={entry.id}
                screenshot={entry}
                onClick={() => onSelectScreenshot?.(entry.id, allIds)}
                actions={<BookmarkButton screenshotId={entry.id} />}
              />
            ))}
          </div>
        </div>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete moment"
          description={<>Are you sure you want to delete <strong>"{collection?.name}"</strong>? This cannot be undone.</>}
          confirmLabel="Delete moment"
          cancelLabel="Cancel"
          destructive
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
