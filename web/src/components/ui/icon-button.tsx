import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "@/lib/utils";

type IconButtonProps = {
    icon: LucideIcon;
    label: string;
    size?: "sm" | "md" | "lg";
    variant?: "ghost" | "solid" | "danger";
    loading?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

const SIZES = { sm: "size-6", md: "size-7", lg: "size-8" } as const;
const ICON_SIZES = { sm: "size-3.5", md: "size-4", lg: "size-4" } as const;

/** 图标按钮（spec §6.3）。hover 走语义 hover（画布 L2 域由容器 data-scope="canvas"
 *  提供的 --icon-hover 覆写，见 globals.css）；命中区经 before 扩展至 ≥32px。
 *  注：`(--var, fallback)` 简写内不能有空格，否则 Tailwind 不生成该工具类。 */
export function IconButton({ icon: Icon, label, size = "md", variant = "ghost", loading, disabled, className, ...rest }: IconButtonProps): ReactElement {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled || loading}
            className={cn(
                "relative grid place-items-center rounded-md transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring/50 before:absolute before:-inset-1 before:content-['']",
                SIZES[size],
                variant === "ghost" && "hover:bg-(--icon-hover,var(--accent)) active:bg-(--icon-active,var(--accent))",
                variant === "solid" && "bg-foreground text-background hover:opacity-90",
                variant === "danger" && "text-danger hover:bg-danger/10",
                (disabled || loading) && "pointer-events-none opacity-50",
                className,
            )}
            {...rest}
        >
            {loading ? <LoaderCircle className={cn(ICON_SIZES[size], "animate-spin")} /> : <Icon className={ICON_SIZES[size]} aria-hidden />}
        </button>
    );
}
