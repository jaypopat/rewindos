import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, Trash2, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useRename } from "@/hooks/useRename";

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

export function ChatSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeChatId, selectChat, startNewChat } = useAskChat();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");

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

  const renaming = useRename<number>((id, value) => {
    const fallback = chats.find((c) => c.id === id)?.title ?? "";
    rename.mutate({ id, title: value || fallback });
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
    <aside
      aria-label="Chat history"
      inert={!open}
      className={cn(
        "absolute left-0 top-12 bottom-0 z-20 w-64 flex flex-col min-h-0 bg-surface-raised border-r border-line shadow-[16px_0_40px_-20px_rgba(0,0,0,0.7)]",
        "transition-[transform,opacity] duration-200 ease-quiet",
        open ? "translate-x-0 opacity-100" : "-translate-x-3 opacity-0 pointer-events-none",
      )}
    >
      {/* Header */}
      <div className="p-3 border-b border-line space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-faint uppercase tracking-[0.18em]">
            Chats
          </span>
          <div className="flex-1 h-px bg-line" />
          <span className="font-mono text-[10px] text-text-faint">
            {chats.length}
          </span>
        </div>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            startNewChat();
            onClose();
          }}
          className="group w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12.5px] font-medium text-text-primary border border-line-2 hover:border-line-hi hover:bg-panel transition-colors"
        >
          <Plus className="size-3.5" strokeWidth={1.7} />
          New chat
        </Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-text-muted pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="bg-transparent pl-8 pr-7 text-[12.5px]"
          />
          {query && (
            <Button
              variant="quiet"
              size="icon-xs"
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 size-auto p-0 text-text-muted hover:text-text-primary"
              aria-label="clear search"
            >
              <X className="size-3" />
            </Button>
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
                <button type="button"
                  key={h.message_id}
                  onClick={() => {
                    selectChat(h.chat_id);
                    onClose();
                  }}
                  className="group w-full px-3 py-2 text-left cursor-pointer hover:bg-panel border-l-2 border-transparent hover:border-line-hi transition-colors"
                >
                  <div className="font-sans text-xs text-text-primary truncate group-hover:text-text-primary">
                    {h.chat_title}
                  </div>
                  <div className="font-mono text-[10px] text-text-muted/70 mt-0.5 line-clamp-2">
                    <SnippetText snippet={h.snippet} />
                  </div>
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
                const isRenaming = renaming.isRenaming(c.id);
                return (
                  <div
                    key={c.id}
                    className={cn(
                      "group relative border-l-2 transition-colors",
                      active
                        ? "border-accent bg-panel"
                        : "border-transparent hover:bg-panel",
                    )}
                  >
                    {isRenaming ? (
                      <div className="px-3 py-2">
                        <Input
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => renaming.setValue(e.target.value)}
                          onBlur={renaming.commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") {
                              // cancel the rename only — don't let the
                              // drawer's global Escape handler also fire
                              e.stopPropagation();
                              renaming.cancel();
                            }
                          }}
                          className="h-auto w-full rounded-none border-0 border-b border-accent-line bg-transparent p-0 text-[12.5px]"
                        />
                        <ChatMeta chat={c} />
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            selectChat(c.id);
                            onClose();
                          }}
                          className="w-full px-3 py-2 text-left cursor-pointer"
                        >
                          <span
                            className={cn(
                              "block truncate pr-16 text-[12.5px] font-[450]",
                              active ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary",
                            )}
                          >
                            {c.title}
                          </span>
                          <ChatMeta chat={c} />
                        </button>
                        <div className="absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <IconButton
                              onClick={(e) => {
                                e.stopPropagation();
                                renaming.start(c.id, c.title);
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
                              hoverClass="hover:text-accent-hi"
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
                );
              })}
            </Section>
          ))
        )}
      </div>
    </aside>
  );
}

function ChatMeta({ chat }: { chat: Chat }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-faint mt-1">
      <span
        className={cn(
          chat.backend === "claude" ? "text-accent-hi/80" : "text-text-muted",
        )}
      >
        {chat.backend}
      </span>
      <span className="text-border">·</span>
      <span>{relativeTime(chat.last_activity_at)}</span>
    </div>
  );
}

// FTS5 snippets arrive as text with <mark> delimiters; render them as React
// children so no other markup in captured text can execute.
function SnippetText({ snippet }: { snippet: string }) {
  const segments: { text: string; mark: boolean; offset: number }[] = [];
  let offset = 0;
  for (const part of snippet.split(/(<mark>[\s\S]*?<\/mark>)/g)) {
    const m = part.match(/^<mark>([\s\S]*)<\/mark>$/);
    segments.push({ text: m ? m[1] : part, mark: !!m, offset });
    offset += part.length;
  }
  return (
    <>
      {segments.map((s) =>
        s.mark ? (
          <mark key={s.offset} className="bg-semantic/20 text-semantic">
            {s.text}
          </mark>
        ) : (
          s.text || null
        ),
      )}
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-3 pt-2 pb-1">
        <span className="font-mono text-[10px] text-text-faint uppercase tracking-[0.18em]">
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
    <Button
      variant="quiet"
      size="icon-xs"
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "size-auto p-1 text-text-muted transition-colors",
        hoverClass,
      )}
    >
      {children}
    </Button>
  );
}

function relativeTime(ts: number): string {
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
