import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
    default: "bg-foreground/10 text-foreground",
    outline: "border border-border text-muted-foreground",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
    info: "bg-info/10 text-info",
} as const;

export function Badge({ variant = "default", children }: { variant?: keyof typeof VARIANTS; children: ReactNode }): ReactElement {
    return <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium leading-none tabular-nums", VARIANTS[variant])}>{children}</span>;
}
