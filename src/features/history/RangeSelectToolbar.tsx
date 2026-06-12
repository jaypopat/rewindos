import { Crosshair, FolderPlus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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
    <div className="shrink-0 border-t border-line bg-surface-base/95 backdrop-blur-sm px-4 py-3">
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
            <Input
              ref={(el) => el?.focus()}
              value={rangeSaveName}
              onChange={(e) => setRangeSaveName(e.target.value)}
              placeholder="Collection name..."
              className="w-44 rounded bg-transparent px-2 text-xs"
            />
            <Button
              variant="link"
              size="xs"
              type="submit"
              disabled={!rangeSaveName.trim() || rangeSaving}
              className="text-accent hover:text-accent/80 text-xs font-medium disabled:opacity-40 px-0 no-underline hover:no-underline"
            >
              {rangeSaving ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="quiet"
              size="xs"
              type="button"
              onClick={() => { setShowRangeNameInput(false); setRangeSaveName(""); }}
              className="text-text-muted hover:text-text-secondary text-xs px-0"
            >
              Back
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              type="button"
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
              className="flex items-center gap-1.5 h-auto px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderPlus className="size-3" />
              Save as Collection
            </Button>
            <Button
              variant="quiet"
              type="button"
              onClick={onClear}
              className="h-auto px-2.5 py-1.5 text-xs text-text-muted hover:text-text-secondary"
            >
              Clear
            </Button>
            <Button
              variant="quiet"
              size="icon-sm"
              type="button"
              onClick={onExit}
              className="p-1.5 size-auto text-text-muted hover:text-text-secondary"
              title="Exit range select"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
