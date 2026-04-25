import { useHotkey } from "@tanstack/react-hotkeys";

export function useGlobalKeyboard({
  onSearch,
  onEscape,
}: {
  onSearch: () => void;
  onEscape?: () => void;
}) {
  useHotkey("/", () => onSearch());
  useHotkey("Escape", () => onEscape?.(), { enabled: !!onEscape });
}
