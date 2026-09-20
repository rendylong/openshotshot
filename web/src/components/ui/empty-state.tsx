import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title?: string; description?: string; action?: ReactNode }): ReactElement {
    return (
        <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 py-8 text-center">
            <Icon className="size-10 text-muted-foreground/60" aria-hidden />
            {title ? <div className="text-sm font-medium text-foreground">{title}</div> : null}
            {description ? <p className="max-w-xs text-xs text-muted-foreground">{description}</p> : null}
            {action}
        </div>
    );
}
