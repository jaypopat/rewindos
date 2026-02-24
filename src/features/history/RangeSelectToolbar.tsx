import { Crosshair, FolderPlus, X } from "lucide-react";

interface RangeSelectToolbarProps {
  rangeStart: number | null;
  rangeEnd: number | null;
  rangeDisplayText: string;
  rangeSaveName: string;
  setRangeSaveName: (name: string) => void;
  rangeSaving: boolean;
  showRangeNameInput: boolean;
  setShowRangeNameInput: (show: boolean) => void;
  onSaveAsCollection: () => void;
  onClear: () => void;
  onExit: () => void;
}

export function RangeSelectToolbar({
  rangeStart,
  rangeEnd,
  rangeDisplayText,
  rangeSaveName,
  setRangeSaveName,
  rangeSaving,
  showRangeNameInput,
  setShowRangeNameInput,
  onSaveAsCollection,
  onClear,
  onExit,
}: RangeSelectToolbarProps) {
  if (rangeStart === null) return null;

  return (
    <div className="shrink-0 border-t border-border/50 bg-surface-base/95 backdrop-blur-sm px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Crosshair className="size-3.5 text-accent shrink-0" />
          <span className="text-sm text-text-secondary">
            {rangeEnd !== null ? (
              <>Selected: <span className="text-text-primary font-medium">{rangeDisplayText}</span></>
            ) : (
              <span className="text-text-muted">{rangeDisplayText}</span>
            )}
          </span>
        </div>
        {showRangeNameInput ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSaveAsCollection();
            }}
            className="flex items-center gap-2"
          >
            <input
              autoFocus
              value={rangeSaveName}
              onChange={(e) => setRangeSaveName(e.target.value)}
              placeholder="Collection name..."
              className="text-xs bg-transparent border border-border/50 rounded px-2 py-1.5 w-44 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
            <button
              type="submit"
              disabled={!rangeSaveName.trim() || rangeSaving}
              className="text-accent hover:text-accent/80 text-xs font-medium disabled:opacity-40 transition-colors"
            >
              {rangeSaving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setShowRangeNameInput(false); setRangeSaveName(""); }}
              className="text-text-muted hover:text-text-secondary text-xs transition-colors"
            >
              Back
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (rangeEnd !== null && rangeStart !== null) {
                  const sd = new Date(rangeStart * 1000);
                  const ed = new Date(rangeEnd * 1000);
                  const tf = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  setRangeSaveName(`${tf(sd)} \u2014 ${tf(ed)}`);
                }
                setShowRangeNameInput(true);
              }}
              disabled={rangeEnd === null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderPlus className="size-3" />
              Save as Collection
            </button>
            <button
              onClick={onClear}
              className="px-2.5 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              Clear
            </button>
            <button
              onClick={onExit}
              className="p-1.5 text-text-muted hover:text-text-secondary transition-colors"
              title="Exit range select"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
