import { useEffect } from "react";

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el as HTMLElement).isContentEditable
  );
}

export function useGlobalKeyboard({
  onSearch,
  onEscape,
  isDetailView,
}: {
  onSearch: () => void;
  onEscape: () => void;
  isDetailView: boolean;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !isInputFocused()) {
        e.preventDefault();
        onSearch();
      }
      if (e.key === "Escape" && isDetailView) {
        onEscape();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSearch, onEscape, isDetailView]);
}
