const APP_COLORS = [
  "#e4e4e7", // zinc
  "#a78bfa", // violet
  "#34d399", // emerald
  "#f472b6", // pink
  "#fb923c", // orange
  "#60a5fa", // blue
  "#facc15", // yellow
  "#e879f9", // fuchsia
  "#2dd4bf", // teal
  "#f87171", // red
  "#818cf8", // indigo
  "#a3e635", // lime
] as const;

export function getAppColor(appName: string | null | undefined): string {
  if (!appName) return APP_COLORS[0];
  let hash = 0;
  for (let i = 0; i < appName.length; i++) {
    hash += appName.charCodeAt(i);
  }
  return APP_COLORS[hash % APP_COLORS.length];
}

export function getAppColorIndex(appName: string | null | undefined): number {
  if (!appName) return 0;
  let hash = 0;
  for (let i = 0; i < appName.length; i++) {
    hash += appName.charCodeAt(i);
  }
  return hash % APP_COLORS.length;
}

export { APP_COLORS };
