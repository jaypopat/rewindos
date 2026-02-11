import { getAppColor } from "@/lib/app-colors";

interface AppDotProps {
  appName: string | null | undefined;
  size?: number;
  className?: string;
}

export function AppDot({ appName, size = 8, className = "" }: AppDotProps) {
  const color = getAppColor(appName);
  return (
    <span
      className={`inline-block rounded-full shrink-0 ${className}`}
      style={{ width: size, height: size, backgroundColor: color }}
    />
  );
}
