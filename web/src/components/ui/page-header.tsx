import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ eyebrow, title, description, actions, className }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; className?: string }): ReactElement {
    return (
        <header className={cn("flex flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-8", className)}>
            <div>
                {eyebrow ? <div className="text-meta font-medium uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</div> : null}
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
                {description ? <p className="mt-1.5 text-xs text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
    );
}
