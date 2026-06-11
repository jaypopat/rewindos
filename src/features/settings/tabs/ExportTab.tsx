import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { vaultExportDay, vaultExportRange } from "@/lib/api";
import { dateToKey } from "@/lib/time-ranges";
import { subDays } from "date-fns";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S,
    key: K,
    value: AppConfig[S][K],
  ) => void;
}

const ALL_SECTIONS = [
  { id: "journal", label: "Journal" },
  { id: "summary", label: "Summary" },
  { id: "meetings", label: "Meetings" },
  { id: "moments", label: "Moments" },
  { id: "stats", label: "Stats" },
] as const;

type SectionId = (typeof ALL_SECTIONS)[number]["id"];

function embedSnippet(format: "obsidian" | "logseq", companionDir: string): string {
  const placeholder = `${companionDir}/YYYY-MM-DD`;
  if (format === "obsidian") return `![[${placeholder}]]`;
  return `{{embed [[${placeholder}]]}}`;
}

export function ExportTab({ config, update }: TabProps) {
  const vc = config.vault_export;

  const [copied, setCopied] = useState(false);
  const [showBackfill, setShowBackfill] = useState(false);
  const [backfillFrom, setBackfillFrom] = useState(() => dateToKey(subDays(new Date(), 7)));
  const [backfillTo, setBackfillTo] = useState(() => dateToKey(new Date()));

  const todayStr = dateToKey(new Date());
  const snippet = embedSnippet(vc.format, vc.companion_dir);

  const handleCopySnippet = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const writeToday = useMutation({
    mutationFn: () => vaultExportDay(todayStr),
  });

  const backfill = useMutation({
    mutationFn: () => vaultExportRange(backfillFrom, backfillTo),
  });

  const toggleSection = (id: SectionId, checked: boolean) => {
    const next = checked
      ? [...vc.sections, id]
      : vc.sections.filter((s) => s !== id);
    update("vault_export", "sections", next);
  };

  return (
    <>
      <SectionTitle>Vault / Graph Export</SectionTitle>

      <Field label="Enabled" hint="Write a daily memory note into your vault">
        <Toggle
          checked={vc.enabled}
          onChange={(v) => update("vault_export", "enabled", v)}
        />
      </Field>

      <Field label="Format">
        <Select
          value={vc.format}
          onValueChange={(v) =>
            update("vault_export", "format", v as "obsidian" | "logseq")
          }
        >
          <SelectTrigger className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="obsidian" className="font-mono">
              Obsidian
            </SelectItem>
            <SelectItem value="logseq" className="font-mono">
              Logseq
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Vault path"
        hint="Absolute path to your Obsidian vault / Logseq graph root"
      >
        <TextInput
          value={vc.vault_path}
          onChange={(v) => update("vault_export", "vault_path", v)}
        />
      </Field>

      <SectionTitle>Note Content</SectionTitle>

      <div className="py-3.5 border-b border-line">
        <p className="text-sm font-medium text-text-primary">Sections</p>
        <p className="text-[12.5px] text-text-muted mt-0.5 leading-relaxed">
          Choose which sections appear in each daily note.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {ALL_SECTIONS.map(({ id, label }) => {
            const active = vc.sections.includes(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleSection(id, !active)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono transition-colors border ${
                  active
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "bg-panel border-line text-text-secondary hover:text-text-primary hover:border-line/80"
                }`}
              >
                {active && (
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                )}
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <Field label="Key moments" hint="Max screenshot moments per day (0 disables key moments)">
        <NumberInput
          value={vc.max_moments}
          min={0}
          max={24}
          onChange={(v) => update("vault_export", "max_moments", v)}
        />
      </Field>

      <Field label="Copy thumbnails" hint="Copy screenshot thumbnails into the vault alongside the note">
        <Toggle
          checked={vc.copy_thumbnails}
          onChange={(v) => update("vault_export", "copy_thumbnails", v)}
        />
      </Field>

      <SectionTitle>Schedule</SectionTitle>

      <Field label="Finalize day at hour" hint="Hour (0–23) after which the day's note is finalized; if the machine was asleep, the previous day is caught up on wake or after midnight">
        <NumberInput
          value={vc.end_of_day_hour}
          min={0}
          max={23}
          onChange={(v) => update("vault_export", "end_of_day_hour", v)}
        />
      </Field>

      <SectionTitle>Embed Snippet</SectionTitle>

      <div className="py-3.5 border-b border-line space-y-2">
        <p className="text-[12.5px] text-text-muted leading-relaxed">
          Paste into your daily-note template to embed today's memory note.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-panel border border-line rounded px-3 py-2 text-text-secondary select-all overflow-x-auto whitespace-nowrap">
            {snippet}
          </code>
          <Button
            variant="ghost"
            type="button"
            onClick={handleCopySnippet}
            className="h-auto p-0 flex items-center gap-1.5 text-xs text-accent hover:bg-transparent hover:text-accent/80 transition-colors shrink-0"
          >
            <Copy className="size-3" strokeWidth={2} />
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>

      <SectionTitle>Manual Export</SectionTitle>

      <div className="py-3.5 border-b border-line space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant="editorial"
            size="editorial"
            onClick={() => writeToday.mutate()}
            disabled={writeToday.isPending}
          >
            {writeToday.isPending ? "writing..." : "Write today now"}
          </Button>
          {writeToday.isSuccess && (
            <span className="font-mono text-[11px] text-signal-active">
              export started
            </span>
          )}
          {writeToday.isError && (
            <span className="font-mono text-[11px] text-signal-error">
              {String(writeToday.error)}
            </span>
          )}
        </div>

        <div>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setShowBackfill((v) => !v)}
            className="h-auto p-0 text-xs text-text-secondary hover:text-text-primary hover:bg-transparent transition-colors font-mono"
          >
            {showBackfill ? "▾ Backfill…" : "▸ Backfill…"}
          </Button>
        </div>

        {showBackfill && (
          <div className="space-y-3 pl-0">
            <div className="flex gap-3">
              <div className="flex-1">
                <label htmlFor="vault-backfill-from" className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                  From
                </label>
                <Input
                  id="vault-backfill-from"
                  type="date"
                  value={backfillFrom}
                  onChange={(e) => setBackfillFrom(e.target.value)}
                  className="mt-1 text-xs font-mono"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="vault-backfill-to" className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                  To
                </label>
                <Input
                  id="vault-backfill-to"
                  type="date"
                  value={backfillTo}
                  onChange={(e) => setBackfillTo(e.target.value)}
                  className="mt-1 text-xs font-mono"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="editorial"
                size="editorial"
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending || !backfillFrom || !backfillTo || backfillFrom > backfillTo}
              >
                {backfill.isPending ? "running..." : "Run backfill"}
              </Button>
              {backfill.isSuccess && (
                <span className="font-mono text-[11px] text-signal-active">
                  export started
                </span>
              )}
              {backfill.isError && (
                <span className="font-mono text-[11px] text-signal-error">
                  {String(backfill.error)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
