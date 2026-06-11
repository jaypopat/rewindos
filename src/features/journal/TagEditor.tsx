import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { setJournalTags, listAllJournalTags, type JournalTag } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { getAppColor } from "@/lib/app-colors";
import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface TagEditorProps {
  entryId: number;
  tags: JournalTag[];
  onTagsChanged: () => void;
}

export function TagEditor({ entryId, tags, onTagsChanged }: TagEditorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: allTags = [] } = useQuery({
    queryKey: queryKeys.allJournalTags(),
    queryFn: listAllJournalTags,
    staleTime: 60_000,
  });

  const suggestions = useMemo(() => {
    if (!input.trim())
      return allTags.filter((t) => !tags.some((et) => et.name === t.name)).slice(0, 5);
    const lower = input.toLowerCase();
    return allTags
      .filter((t) => t.name.toLowerCase().includes(lower) && !tags.some((et) => et.name === t.name))
      .slice(0, 5);
  }, [input, allTags, tags]);

  const qc = useQueryClient();
  const setTagsMutation = useMutation({
    mutationFn: (tagNames: string[]) => setJournalTags(entryId, tagNames),
    onSuccess: () => {
      // keep the suggestions list in sync when a brand-new tag is created
      qc.invalidateQueries({ queryKey: queryKeys.allJournalTags() });
      onTagsChanged();
    },
  });

  const addTag = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    setTagsMutation.mutate([...tags.map((t) => t.name), trimmed]);
    setInput("");
    setIsAdding(false);
  };

  const removeTag = (name: string) => {
    setTagsMutation.mutate(tags.flatMap((t) => (t.name === name ? [] : [t.name])));
  };

  const startAdding = () => {
    setIsAdding(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  if (tags.length === 0 && !isAdding) {
    return (
      <div className="px-5 py-1.5 border-b border-border/50">
        <Button variant="quiet" type="button"
          onClick={startAdding}
          className="h-auto p-0 flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted transition-colors"
        >
          <Plus className="size-2.5" strokeWidth={2} />
          Add tags
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-5 py-1.5 border-b border-border/50 flex-wrap">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md"
          style={{
            backgroundColor: getAppColor(tag.name) + "18",
            color: getAppColor(tag.name),
          }}
        >
          {tag.name}
          <Button variant="ghost" size="icon-xs" type="button"
            onClick={() => removeTag(tag.name)}
            className="size-auto p-0 hover:bg-transparent hover:opacity-70 transition-opacity"
          >
            <X className="size-2.5" strokeWidth={2} />
          </Button>
        </span>
      ))}
      {isAdding ? (
        <div className="relative">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) addTag(input);
              if (e.key === "Escape") {
                setIsAdding(false);
                setInput("");
              }
            }}
            onBlur={() => {
              setTimeout(() => {
                setIsAdding(false);
                setInput("");
              }, 150);
            }}
            placeholder="Tag name..."
            className="h-auto w-20 rounded-none border-0 bg-transparent p-0 text-[10px] placeholder:text-text-muted/50"
          />
          {suggestions.length > 0 && input.trim() && (
            <div className="absolute top-full left-0 mt-1 bg-surface-raised border border-border/50 rounded-md shadow-lg z-10 py-1 min-w-[120px]">
              {suggestions.map((s) => (
                <Button variant="ghost" type="button"
                  key={s.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s.name);
                  }}
                  className="h-auto justify-start w-full text-left text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50 px-2 py-1 transition-colors"
                >
                  {s.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Button variant="quiet" size="icon-xs" type="button"
          onClick={startAdding}
          className="size-auto text-text-muted/40 hover:text-text-muted transition-colors"
        >
          <Plus className="size-3" strokeWidth={2} />
        </Button>
      )}
    </div>
  );
}
