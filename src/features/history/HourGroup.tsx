import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createCollection, getImageUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronRight, FolderPlus, Trash2 } from "lucide-react";
import { sampleEvenly, hourKeyToTimestamp } from "./history-utils";
import type { HourGroup as HourGroupType } from "./history-utils";

interface HourGroupProps {
  group: HourGroupType;
  isOpen: boolean;
  showAll: boolean;
  isInRange: boolean;
  rangeSelectMode: boolean;
  onToggle: () => void;
  onShowAll: () => void;
  onRangeClick: (timestamp: number) => void;
  isEntryInRange: (timestamp: number) => boolean;
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
  onRequestDelete: (key: string) => void;
}

const INITIAL_LIMIT = 30;

export function HourGroupRow({
  group,
  isOpen,
  showAll,
  isInRange,
  rangeSelectMode,
  onToggle,
  onShowAll,
  onRangeClick,
  isEntryInRange,
  onSelectScreenshot,
  onRequestDelete,
}: HourGroupProps) {
  const queryClient = useQueryClient();
  const previews = sampleEvenly(group.entries, 4);
  const allIds = group.entries.map((e) => e.id);

  const [saveCollectionKey, setSaveCollectionKey] = useState<string | null>(null);
  const [saveCollectionName, setSaveCollectionName] = useState("");
  const [savingCollection, setSavingCollection] = useState(false);

  const handleSaveAsCollection = async () => {
    if (!saveCollectionName.trim()) return;
    const datePart = group.key.slice(0, 10);
    const hourNum = parseInt(group.key.slice(-2), 10);
    const hourStart = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
    const hourEnd = new Date(hourStart.getTime() + 3600_000);
    const startTs = Math.floor(hourStart.getTime() / 1000);
    const endTs = Math.floor(hourEnd.getTime() / 1000);

    setSavingCollection(true);
    try {
      await createCollection({
        name: saveCollectionName.trim(),
        start_time: startTs,
        end_time: endTs,
      });
      setSaveCollectionKey(null);
      setSaveCollectionName("");
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    } catch (err) {
      console.error("Failed to save collection:", err);
    } finally {
      setSavingCollection(false);
    }
  };

  const visible = showAll ? group.entries : group.entries.slice(0, INITIAL_LIMIT);
  const remaining = group.entries.length - INITIAL_LIMIT;

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden transition-colors",
      isInRange
        ? "border-accent/50 border-l-2 border-l-accent"
        : "border-border/50",
    )}>
      {/* Hour header */}
      <div className="flex items-center">
        <button
          onClick={() => {
            if (rangeSelectMode) {
              onRangeClick(hourKeyToTimestamp(group.key));
            } else {
              onToggle();
            }
          }}
          className={cn(
            "flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised/40 transition-colors text-left",
            rangeSelectMode && "cursor-crosshair",
          )}
        >
          <ChevronRight className={cn(
            "size-3.5 text-text-muted transition-transform shrink-0",
            isOpen && "rotate-90",
          )} strokeWidth={2} />
          <span className="text-sm text-text-primary font-medium font-mono tabular-nums">
            {group.label}
          </span>
          <span className="text-xs text-text-muted">
            {group.entries.length} capture{group.entries.length !== 1 ? "s" : ""}
          </span>
          {group.topApps.length > 0 && (
            <span className="text-xs text-text-muted truncate">
              {group.topApps.join(", ")}
            </span>
          )}
          <span className="flex-1" />
          {/* Preview thumbnails (collapsed only) */}
          {!isOpen && (
            <div className="flex gap-1.5 shrink-0">
              {previews.map((entry) => (
                <div
                  key={entry.id}
                  className="w-16 h-10 rounded overflow-hidden bg-surface-raised border border-border/30"
                >
                  {entry.thumbnail_path ? (
                    <img
                      src={getImageUrl(entry.thumbnail_path)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-[8px] text-text-muted font-mono">
                        {new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </button>
        {/* Save as collection button */}
        {saveCollectionKey === group.key ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveAsCollection();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 px-2 shrink-0"
          >
            <input
              autoFocus
              value={saveCollectionName}
              onChange={(e) => setSaveCollectionName(e.target.value)}
              placeholder="Collection name..."
              className="text-xs bg-transparent border border-border/50 rounded px-2 py-1 w-36 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
            <button
              type="submit"
              disabled={!saveCollectionName.trim() || savingCollection}
              className="text-accent hover:text-accent/80 text-xs font-medium disabled:opacity-40 transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setSaveCollectionKey(null); setSaveCollectionName(""); }}
              className="text-text-muted hover:text-text-secondary text-xs transition-colors"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSaveCollectionKey(group.key);
              setSaveCollectionName(group.label);
            }}
            className="px-2 py-2.5 text-text-muted/60 hover:text-accent transition-colors shrink-0"
            title={`Save ${group.label} as collection`}
          >
            <FolderPlus className="size-4" strokeWidth={1.5} />
          </button>
        )}
        {/* Delete hour button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(group.key);
          }}
          className="px-3 py-2.5 text-red-400/60 hover:text-red-400 transition-colors shrink-0"
          title={`Delete all captures from ${group.label}`}
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* Expanded grid */}
      {isOpen && (
        <div className="px-4 pb-3 pt-1">
          <div className="grid grid-cols-4 xl:grid-cols-6 gap-2">
            {visible.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  if (rangeSelectMode) {
                    onRangeClick(entry.timestamp);
                  } else {
                    onSelectScreenshot?.(entry.id, allIds);
                  }
                }}
                className={cn(
                  "group relative aspect-video rounded-lg overflow-hidden bg-surface-raised transition-all",
                  rangeSelectMode
                    ? isEntryInRange(entry.timestamp)
                      ? "ring-2 ring-accent border border-accent/50"
                      : "border border-border/30 hover:border-accent/50 cursor-crosshair"
                    : "border border-border/30 hover:border-accent/50 hover:scale-[1.02]",
                )}
              >
                {entry.thumbnail_path ? (
                  <img
                    src={getImageUrl(entry.thumbnail_path)}
                    alt=""
                    className="w-full h-full object-cover opacity-75 group-hover:opacity-100 transition-opacity"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-[9px] text-text-muted font-mono">No preview</span>
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2 py-1.5">
                  <span className="text-[10px] text-white/90 font-mono tabular-nums">
                    {new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {entry.app_name && (
                    <span className="text-[9px] text-white/50 ml-1.5">{entry.app_name}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
          {!showAll && remaining > 0 && (
            <button
              onClick={onShowAll}
              className="mt-2 w-full py-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-colors"
            >
              Load {remaining} more screenshot{remaining !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
