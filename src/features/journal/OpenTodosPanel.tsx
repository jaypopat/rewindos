import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOpenTodos, type OpenTodo } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { dateToKey } from "@/lib/time-ranges";
import { subDays, format, parseISO } from "date-fns";
import { CheckSquare } from "lucide-react";

interface OpenTodosPanelProps {
  onSelectDate: (d: Date) => void;
}

export function OpenTodosPanel({ onSelectDate }: OpenTodosPanelProps) {
  const today = useMemo(() => new Date(), []);
  const startDate = dateToKey(subDays(today, 14));
  const endDate = dateToKey(today);

  const { data: todos = [] } = useQuery({
    queryKey: queryKeys.openTodos(startDate, endDate),
    queryFn: () => getOpenTodos(startDate, endDate),
    staleTime: 60_000,
  });

  const grouped = useMemo(() => {
    // Deduplicate by todo text — keep most recent occurrence only
    const seenTexts = new Set<string>();
    const deduped: OpenTodo[] = [];
    // todos are already ordered by date DESC from backend
    for (const todo of todos) {
      if (!seenTexts.has(todo.text)) {
        seenTexts.add(todo.text);
        deduped.push(todo);
      }
    }
    const map = new Map<string, OpenTodo[]>();
    for (const todo of deduped) {
      const existing = map.get(todo.date) ?? [];
      existing.push(todo);
      map.set(todo.date, existing);
    }
    return map;
  }, [todos]);

  if (grouped.size === 0) return null;

  return (
    <div>
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <CheckSquare className="size-3" strokeWidth={2} />
        Open Todos
      </h3>
      <div className="space-y-2">
        {Array.from(grouped.entries()).map(([date, items]) => (
          <div key={date}>
            <button
              onClick={() => onSelectDate(parseISO(date + "T12:00:00"))}
              className="text-[10px] font-mono text-text-muted hover:text-accent transition-colors mb-0.5"
            >
              {format(parseISO(date), "EEE, MMM d")}
            </button>
            <div className="space-y-0.5">
              {items.map((todo, i) => (
                <button
                  key={`${date}-${i}`}
                  onClick={() => onSelectDate(parseISO(date + "T12:00:00"))}
                  className="w-full text-left text-xs text-text-secondary hover:text-text-primary bg-surface-raised hover:bg-surface-overlay/50 border border-border/30 hover:border-accent/20 rounded-md px-2.5 py-1.5 transition-all leading-relaxed truncate"
                >
                  {todo.text}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
