const APP_COLORS = [
  "#e8825a", // terracotta
  "#c9925e", // ochre
  "#9aa873", // sage
  "#6f97b4", // slate blue
  "#b58bc0", // mauve
  "#cf9090", // rose
  "#d3b25e", // honey
  "#7fa6a0", // teal-sage
  "#b87f5c", // sienna
  "#8e9bb8", // periwinkle
  "#a3a06a", // olive
  "#c47e9e", // dusty pink
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
