import { useState } from "react";

/**
 * Inline rename-in-place flow: one item at a time, seeded with the current
 * name, then committed or cancelled. Commit policy (trimming, empty-value
 * fallbacks, when to actually mutate) belongs to the `onCommit` callback;
 * the hook only owns the editing state.
 */
export function useRename<Id>(onCommit: (id: Id, value: string) => void) {
  const [state, setState] = useState<{ id: Id; value: string } | null>(null);

  return {
    value: state ? state.value : "",
    isRenaming: (id: Id) => state !== null && state.id === id,
    start: (id: Id, initialValue: string) => setState({ id, value: initialValue }),
    setValue: (value: string) => setState((s) => (s ? { ...s, value } : s)),
    cancel: () => setState(null),
    commit: () => {
      if (state) onCommit(state.id, state.value);
      setState(null);
    },
  };
}
