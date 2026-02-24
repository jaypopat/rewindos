import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { setJournalTags, listAllJournalTags, type JournalTag } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { getAppColor } from "@/lib/app-colors";
import { X, Plus } from "lucide-react";

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

  const setTagsMutation = useMutation({
    mutationFn: (tagNames: string[]) => setJournalTags(entryId, tagNames),
    onSuccess: onTagsChanged,
  });

  const addTag = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    setTagsMutation.mutate([...tags.map((t) => t.name), trimmed]);
    setInput("");
    setIsAdding(false);
  };

  const removeTag = (name: string) => {
    setTagsMutation.mutate(tags.filter((t) => t.name !== name).map((t) => t.name));
  };

  useEffect(() => {
    if (isAdding && inputRef.current) inputRef.current.focus();
  }, [isAdding]);

  if (tags.length === 0 && !isAdding) {
    return (
      <div className="px-5 py-1.5 border-b border-border/50">
        <button
          onClick={() => setIsAdding(true)}
          className="flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted transition-colors"
        >
          <Plus className="size-2.5" strokeWidth={2} />
          Add tags
        </button>
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
          <button
            onClick={() => removeTag(tag.name)}
            className="hover:opacity-70 transition-opacity"
          >
            <X className="size-2.5" strokeWidth={2} />
          </button>
        </span>
      ))}
      {isAdding ? (
        <div className="relative">
          <input
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
            className="text-[10px] bg-transparent text-text-primary placeholder:text-text-muted/50 focus:outline-none w-20"
          />
          {suggestions.length > 0 && input.trim() && (
            <div className="absolute top-full left-0 mt-1 bg-surface-raised border border-border/50 rounded-md shadow-lg z-10 py-1 min-w-[120px]">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s.name);
                  }}
                  className="w-full text-left text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50 px-2 py-1 transition-colors"
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="text-text-muted/40 hover:text-text-muted transition-colors"
        >
          <Plus className="size-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
