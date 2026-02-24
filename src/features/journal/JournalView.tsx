import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { ChevronLeft, ChevronRight, Search, Paperclip } from "lucide-react";

import { useJournalEntry } from "./hooks/useJournalEntry";
import { JournalEditor } from "./JournalEditor";
import { TagEditor } from "./TagEditor";
import { JournalSearchPanel } from "./JournalSearchPanel";
import { JournalSidebar } from "./JournalSidebar";
import { AttachedScreenshot } from "./AttachedScreenshot";
import { ScreenshotPicker } from "./ScreenshotPicker";
import { ExportDialog } from "./ExportDialog";

interface JournalViewProps {
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

export function JournalView({ onSelectScreenshot }: JournalViewProps) {
  const j = useJournalEntry();

  const handleEditorUpdate = useCallback(
    (md: string) => {
      j.setContent(md);
    },
    [j.setContent],
  );

  const handleInsertPrompt = useCallback(
    (text: string) => {
      j.setContent((prev: string) => (prev ? prev + "\n" : "") + `\n> ${text}\n`);
    },
    [j.setContent],
  );

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left panel: Editor */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-border/50">
        {/* Date nav + search */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border/50 shrink-0">
          <button onClick={j.goToPrev} className="p-1 text-text-muted hover:text-text-secondary transition-colors">
            <ChevronLeft className="size-4" strokeWidth={2} />
          </button>
          <button
            onClick={j.goToToday}
            className="text-sm font-medium text-text-primary hover:text-accent transition-colors min-w-[140px] text-center"
          >
            {j.formattedDate}
          </button>
          <button
            onClick={j.goToNext}
            className="p-1 text-text-muted hover:text-text-secondary transition-colors"
          >
            <ChevronRight className="size-4" strokeWidth={2} />
          </button>

          {j.isToday && (
            <span className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">today</span>
          )}

          <span className="flex-1" />

          {j.isSaving && <span className="text-[10px] text-text-muted font-mono">saving...</span>}

          <button
            onClick={() => j.setShowSearch(!j.showSearch)}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              j.showSearch ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text-secondary",
            )}
            title="Search journal"
          >
            <Search className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        {/* Tag editor */}
        {j.entry?.id && (
          <TagEditor
            entryId={j.entry.id}
            tags={j.entryTags}
            onTagsChanged={() => {
              j.queryClient.invalidateQueries({ queryKey: queryKeys.journalTags(j.entry!.id) });
              j.queryClient.invalidateQueries({ queryKey: queryKeys.allJournalTags() });
            }}
          />
        )}

        {/* Search overlay */}
        {j.showSearch && (
          <JournalSearchPanel
            onNavigate={(date) => {
              j.goToDate(new Date(date + "T12:00:00"));
              j.setShowSearch(false);
            }}
            onClose={() => j.setShowSearch(false)}
          />
        )}

        {/* Editor area */}
        <div key={j.contentKey} className="flex-1 overflow-y-auto px-5 py-4 animate-fade-in-up">
          {j.entryLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : (
            <JournalEditor
              content={j.content}
              onUpdate={handleEditorUpdate}
              className=""
            />
          )}
        </div>

        {/* Attached screenshots */}
        {(j.journalScreenshots.length > 0 || j.showScreenshotPicker) && (
          <div className="border-t border-border/50 px-5 py-3 shrink-0">
            {j.journalScreenshots.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {j.journalScreenshots.map((js) => (
                  <AttachedScreenshot
                    key={js.id}
                    journalScreenshot={js}
                    onRemove={() => j.detachMutation.mutate(js.screenshot_id)}
                    onClick={() => {
                      const ids = j.journalScreenshots.map((s) => s.screenshot_id);
                      onSelectScreenshot?.(js.screenshot_id, ids);
                    }}
                  />
                ))}
              </div>
            )}
            {j.showScreenshotPicker && (
              <ScreenshotPicker
                dayStart={j.dayStart}
                dayEnd={j.dayEnd}
                attachedIds={j.journalScreenshots.map((s) => s.screenshot_id)}
                appUsage={j.activityData?.app_usage}
                onAttach={(id) => j.attachMutation.mutate(id)}
                onClose={() => j.setShowScreenshotPicker(false)}
              />
            )}
          </div>
        )}

        {/* Bottom bar: attach + writing stats */}
        <div className="flex items-center gap-3 px-5 py-2 border-t border-border/50 shrink-0">
          <button
            onClick={() => j.setShowScreenshotPicker(!j.showScreenshotPicker)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <Paperclip className="size-3" strokeWidth={2} />
            {j.showScreenshotPicker ? "Close" : "Attach"}
          </button>
          {j.journalScreenshots.length > 0 && (
            <span className="text-[10px] text-text-muted font-mono">{j.journalScreenshots.length} attached</span>
          )}
          <span className="flex-1" />
          <span className="text-[10px] font-mono text-text-muted">
            {j.wordCount} words &middot; {j.readingTime} min read
          </span>
        </div>
      </div>

      {/* Right panel: Context sidebar */}
      <JournalSidebar
        selectedDate={j.selectedDate}
        calendarMonth={j.calendarMonth}
        journalDateMap={j.journalDateMap}
        onSelectDate={j.goToDate}
        streak={j.streak}
        ollamaAvailable={j.ollamaAvailable}
        activityData={j.activityData}
        prompts={j.prompts}
        onInsertPrompt={handleInsertPrompt}
        onShowExport={() => j.setShowExport(true)}
      />

      {/* Export dialog */}
      {j.showExport && <ExportDialog onClose={() => j.setShowExport(false)} />}
    </div>
  );
}
