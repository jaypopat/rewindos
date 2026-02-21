import { createElement } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Renders a string containing `<mark>` tags as safe React elements.
 */
export function HighlightedText({ html }: { html: string }) {
  const parts = html.split(/(<mark>[\s\S]*?<\/mark>)/g);
  const children = parts.map((part, i) => {
    if (part.startsWith("<mark>") && part.endsWith("</mark>")) {
      return createElement("mark", { key: i }, part.slice(6, -7));
    }
    return part || null;
  });
  return createElement("span", null, ...children);
}
