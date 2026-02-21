import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listCollections,
  addToCollection,
  removeFromCollection,
  createCollection,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FolderPlus, Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface AddToCollectionMenuProps {
  screenshotId: number;
  className?: string;
}

export function AddToCollectionMenu({ screenshotId, className }: AddToCollectionMenuProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const queryClient = useQueryClient();

  const { data: collections = [] } = useQuery({
    queryKey: queryKeys.collections(),
    queryFn: listCollections,
    enabled: open,
  });

  // Track membership in local state after mutations
  const [memberOf, setMemberOf] = useState<Set<number>>(new Set());

  const addMutation = useMutation({
    mutationFn: (collectionId: number) => addToCollection(collectionId, screenshotId),
    onSuccess: (_data, collectionId) => {
      setMemberOf((prev) => new Set([...prev, collectionId]));
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (collectionId: number) => removeFromCollection(collectionId, screenshotId),
    onSuccess: (_data, collectionId) => {
      setMemberOf((prev) => {
        const next = new Set(prev);
        next.delete(collectionId);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
    },
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createCollection({ name }),
    onSuccess: async (newId) => {
      await addToCollection(newId, screenshotId);
      setMemberOf((prev) => new Set([...prev, newId]));
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      setCreating(false);
      setNewName("");
    },
  });

  const handleToggle = (collectionId: number) => {
    if (memberOf.has(collectionId)) {
      removeMutation.mutate(collectionId);
    } else {
      addMutation.mutate(collectionId);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setCreating(false); } }}>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "text-text-muted hover:text-text-primary transition-colors",
            className,
          )}
          title="Add to collection"
        >
          <FolderPlus className="size-3.5" strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-1.5"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted px-2 py-1">
          Collections
        </div>
        {collections.length === 0 && !creating && (
          <div className="px-2 py-3 text-xs text-text-muted text-center">
            No collections yet
          </div>
        )}
        {collections.map((col) => (
          <button
            key={col.id}
            onClick={() => handleToggle(col.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-raised rounded transition-colors text-left"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: col.color }}
            />
            <span className="flex-1 truncate">{col.name}</span>
            {memberOf.has(col.id) && (
              <Check className="size-3 text-accent shrink-0" strokeWidth={2} />
            )}
          </button>
        ))}
        <div className="border-t border-border/30 mt-1 pt-1">
          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) createMutation.mutate(newName.trim());
              }}
              className="flex items-center gap-1.5 px-1"
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Collection name..."
                className="flex-1 text-xs bg-transparent border border-border/50 rounded px-2 py-1 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
              />
              <button
                type="submit"
                disabled={!newName.trim() || createMutation.isPending}
                className="text-accent hover:text-accent/80 disabled:opacity-40 transition-colors p-1"
              >
                <Check className="size-3.5" strokeWidth={2} />
              </button>
            </form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-accent hover:bg-surface-raised rounded transition-colors"
            >
              <Plus className="size-3" strokeWidth={2} />
              Create collection...
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
