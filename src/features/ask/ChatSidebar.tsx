import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, Trash2, X, Download } from "lucide-react";
import {
  deleteChat,
  exportChatMarkdown,
  listChats,
  renameChat,
  searchChats,
  type Chat,
  type ChatSearchHit,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useAskChat } from "@/context/AskContext";

type Bucket = { label: string; chats: Chat[] };

const DAY = 86_400;

function groupByRecency(chats: Chat[]): Bucket[] {
  const now = Math.floor(Date.now() / 1000);
  const today = now - (now % DAY); // midnight today (UTC-ish — good enough for grouping)
  const yesterday = today - DAY;
  const weekAgo = today - 7 * DAY;
  const monthAgo = today - 30 * DAY;

  const buckets: Bucket[] = [
    { label: "today", chats: [] },
    { label: "yesterday", chats: [] },
    { label: "last 7 days", chats: [] },
    { label: "last 30 days", chats: [] },
    { label: "older", chats: [] },
  ];

  for (const c of chats) {
    const t = c.last_activity_at;
    if (t >= today) buckets[0].chats.push(c);
    else if (t >= yesterday) buckets[1].chats.push(c);
    else if (t >= weekAgo) buckets[2].chats.push(c);
    else if (t >= monthAgo) buckets[3].chats.push(c);
    else buckets[4].chats.push(c);
  }
  return buckets.filter((b) => b.chats.length > 0);
}

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

  const grouped = useMemo(() => groupByRecency(chats), [chats]);

  const isSearching = query.trim().length > 1;
  const dedupedHits = useMemo(() => {
    const seen = new Set<number>();
    return hits.filter((h) => {
      if (seen.has(h.chat_id)) return false;
      seen.add(h.chat_id);
      return true;
    });
  }, [hits]);

  return (
    <div className="w-64 shrink-0 border-r border-border/50 flex flex-col min-h-0 bg-surface-raised/10">
      {/* Header */}
      <div className="p-3 border-b border-border/50 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
            chats
          </span>
          <div className="flex-1 h-px bg-border/40" />
          <span className="font-mono text-[10px] text-text-muted/70">
            {chats.length}
          </span>
        </div>
        <button
          onClick={startNewChat}
          className="group w-full flex items-center justify-center gap-1.5 px-2 py-2 font-mono text-[11px] text-semantic border border-semantic/40 hover:bg-semantic/10 hover:border-semantic/60 transition-all uppercase tracking-wider"
        >
          <Plus className="size-3 group-hover:scale-110 transition-transform" strokeWidth={2} />
          new chat
        </button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-text-muted pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search"
            className="w-full pl-8 pr-7 py-1.5 bg-surface-raised/30 border border-border/40 font-mono text-xs text-text-primary placeholder:text-text-muted/50 outline-none focus:border-semantic/40 focus:bg-surface-raised/50 transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              aria-label="clear search"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isSearching ? (
          dedupedHits.length === 0 ? (
            <EmptyMessage>no matches</EmptyMessage>
          ) : (
            <Section label={`matches (${dedupedHits.length})`}>
              {dedupedHits.map((h) => (
                <button
                  key={h.message_id}
                  onClick={() => selectChat(h.chat_id)}
                  className="group w-full px-3 py-2 text-left cursor-pointer hover:bg-surface-raised/40 border-l-2 border-transparent hover:border-semantic/40 transition-colors"
                >
                  <div className="font-sans text-xs text-text-primary truncate group-hover:text-text-primary">
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
                </button>
              ))}
            </Section>
          )
        ) : chats.length === 0 ? (
          <EmptyMessage>no chats yet</EmptyMessage>
        ) : (
          grouped.map((bucket) => (
            <Section key={bucket.label} label={bucket.label}>
              {bucket.chats.map((c) => {
                const active = activeChatId === c.id;
                const isRenaming = renamingId === c.id;
                return (
                  <div
                    key={c.id}
                    className={cn(
                      "group px-3 py-2 cursor-pointer border-l-2 transition-colors",
                      active
                        ? "border-semantic bg-semantic/[0.06]"
                        : "border-transparent hover:bg-surface-raised/40 hover:border-border/50",
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
                          <span
                            className={cn(
                              "flex-1 font-sans text-xs truncate",
                              active ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary",
                            )}
                          >
                            {c.title}
                          </span>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <IconButton
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingId(c.id);
                                setRenameValue(c.title);
                              }}
                              title="rename"
                              hoverClass="hover:text-text-primary"
                            >
                              <Pencil className="size-3" />
                            </IconButton>
                            <IconButton
                              onClick={async (e) => {
                                e.stopPropagation();
                                const md = await exportChatMarkdown(c.id);
                                const blob = new Blob([md], { type: "text/markdown" });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `${c.title.replace(/[^a-z0-9]/gi, "_")}.md`;
                                a.click();
                                URL.revokeObjectURL(url);
                              }}
                              title="export markdown"
                              hoverClass="hover:text-semantic"
                            >
                              <Download className="size-3" />
                            </IconButton>
                            <IconButton
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Delete "${c.title}"?`)) del.mutate(c.id);
                              }}
                              title="delete"
                              hoverClass="hover:text-signal-error"
                            >
                              <Trash2 className="size-3" />
                            </IconButton>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-muted/60 mt-1">
                      <span
                        className={cn(
                          c.backend === "claude" ? "text-semantic/70" : "text-text-muted/70",
                        )}
                      >
                        {c.backend}
                      </span>
                      <span className="text-border">·</span>
                      <span>{relativeTime(c.last_activity_at)}</span>
                    </div>
                  </div>
                );
              })}
            </Section>
          ))
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-3 pt-2 pb-1">
        <span className="font-mono text-[10px] text-text-muted/60 uppercase tracking-[0.2em]">
          {label}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-6 font-mono text-[11px] text-text-muted/70 italic">
      {children}
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  hoverClass,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  hoverClass: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "p-1 text-text-muted transition-colors",
        hoverClass,
      )}
    >
      {children}
    </button>
  );
}

function relativeTime(ts: number): string {
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
