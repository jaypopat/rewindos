export interface ClaudeModel {
  id: string; // alias passed to claude CLI --model
  label: string;
  description: string;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "opus",   label: "Claude Opus",   description: "most capable · slowest"  },
  { id: "sonnet", label: "Claude Sonnet", description: "balanced · default"      },
  { id: "haiku",  label: "Claude Haiku",  description: "fastest · cheapest"      },
];

export const DEFAULT_CLAUDE_MODEL = "sonnet";
