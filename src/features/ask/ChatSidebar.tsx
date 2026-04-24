import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, Trash2, X } from "lucide-react";
import {
  deleteChat,
  listChats,
  renameChat,
  searchChats,
  type Chat,
  type ChatSearchHit,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useAskChat } from "@/context/AskContext";

type Item =
  | { kind: "chat"; c: Chat }
  | { kind: "hit"; h: ChatSearchHit };

export function ChatSidebar() {
  const { activeChatId, selectChat, startNewChat } = useAskChat();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const { data: chats = [] } = useQuery<Chat[]>({
    queryKey: queryKeys.chats(),
    queryFn: () => listChats(200),
    staleTime: 5_000,
  });

  const { data: hits = [] } = useQuery<ChatSearchHit[]>({
    queryKey: queryKeys.chatSearch(query),
    queryFn: () => searchChats(query),
    enabled: query.trim().length > 1,
    staleTime: 2_000,
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) =>
      renameChat(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.chats() }),
  });

  const del = useMutation({
    mutationFn: (id: number) => deleteChat(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chats() });
      startNewChat();
    },
  });

  const displayList: Item[] = useMemo(() => {
    if (query.trim().length <= 1) {
      return chats.map((c) => ({ kind: "chat", c }));
    }
    const seen = new Set<number>();
    const items: Item[] = [];
    for (const h of hits) {
      if (seen.has(h.chat_id)) continue;
      seen.add(h.chat_id);
      items.push({ kind: "hit", h });
    }
    return items;
  }, [query, chats, hits]);

  return (
    <div className="w-56 shrink-0 border-r border-border/50 flex flex-col min-h-0">
      <div className="p-2 border-b border-border/50 space-y-1.5">
        <button
          onClick={startNewChat}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 font-mono text-[11px] text-semantic border border-semantic/40 hover:bg-semantic/10 transition-all uppercase tracking-wider"
        >
          <Plus className="size-3" strokeWidth={2} />
          new chat
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search chats"
            className="w-full pl-7 pr-2 py-1.5 bg-surface-raised/30 border border-border/40 font-mono text-xs text-text-primary placeholder:text-text-muted/50 outline-none focus:border-semantic/40"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {displayList.length === 0 && (
          <div className="px-3 py-4 font-mono text-[11px] text-text-muted/70 italic">
            {query ? "no matches" : "no chats yet"}
          </div>
        )}
        {displayList.map((item) => {
          if (item.kind === "chat") {
            const c = item.c;
            const active = activeChatId === c.id;
            const isRenaming = renamingId === c.id;
            return (
              <div
                key={c.id}
                className={cn(
                  "group px-2 py-1.5 cursor-pointer border-l-2 transition-colors",
                  active
                    ? "border-semantic bg-semantic/5"
                    : "border-transparent hover:bg-surface-raised/30",
                )}
                onClick={() => !isRenaming && selectChat(c.id)}
              >
                <div className="flex items-center gap-1">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => {
                        rename.mutate({
                          id: c.id,
                          title: renameValue || c.title,
                        });
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="flex-1 bg-transparent border-b border-semantic/50 font-sans text-xs text-text-primary outline-none"
                    />
                  ) : (
                    <>
                      <span className="flex-1 font-sans text-xs text-text-primary truncate">
                        {c.title}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-primary"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${c.title}"?`)) del.mutate(c.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-signal-error"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </>
                  )}
                </div>
                <div className="font-mono text-[10px] text-text-muted/60 mt-0.5">
                  {c.backend} · {relativeTime(c.last_activity_at)}
                </div>
              </div>
            );
          }
          const h = item.h;
          return (
            <div
              key={h.message_id}
              onClick={() => selectChat(h.chat_id)}
              className="px-2 py-1.5 cursor-pointer hover:bg-surface-raised/30 border-l-2 border-transparent"
            >
              <div className="font-sans text-xs text-text-primary truncate">
                {h.chat_title}
              </div>
              <div
                className="font-mono text-[10px] text-text-muted/70 mt-0.5 line-clamp-2"
                dangerouslySetInnerHTML={{
                  __html: h.snippet.replace(
                    /<mark>/g,
                    '<mark class="bg-semantic/20 text-semantic">',
                  ),
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
