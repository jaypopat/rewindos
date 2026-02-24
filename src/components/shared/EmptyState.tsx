import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-2">
        {Icon && <Icon className="size-8 text-text-muted/30 mx-auto" strokeWidth={1.5} />}
        <p className="text-sm text-text-secondary">{title}</p>
        {description && <p className="text-xs text-text-muted">{description}</p>}
        {action && <div className="pt-2">{action}</div>}
      </div>
    </div>
  );
}
