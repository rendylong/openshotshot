import { LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }): ReactElement {
    return <LoaderCircle className={cn("size-4 animate-spin text-muted-foreground", className)} aria-hidden />;
}
