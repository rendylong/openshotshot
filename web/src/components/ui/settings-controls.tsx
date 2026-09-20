// web/src/components/ui/settings-controls.tsx
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function SettingGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium text-muted-foreground">{title}</div>
            {children}
        </div>
    );
}

export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
    return (
        <div>
            <div className="mb-1.5 text-sm font-medium text-foreground">{label}</div>
            {children}
            {hint ? <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
    );
}

export function OptionPill({ selected, disabled, onClick, children, title, className }: { selected: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; title?: string; className?: string }): ReactElement {
    return (
        <button
            type="button"
            title={title}
            aria-pressed={selected}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "h-9 whitespace-nowrap rounded-full border px-2 text-[12.5px] leading-none transition-colors duration-150",
                className,
                selected ? "border-foreground bg-foreground text-background" : "border-input hover:border-foreground/40",
                disabled && "pointer-events-none opacity-50",
                "focus-visible:outline-2 focus-visible:outline-ring/50",
            )}
        >
            {children}
        </button>
    );
}

/** 快选 pill + 「自定义」按钮（D12）：点击原位变输入框；当前值不在快选档时按钮选中并带值。 */
export function QuickPillRow({ values, value, format, min, max, parse, onChange, gridClassName }: {
    values: Array<number | string>;
    value: number | string;
    format: (v: number | string) => string;
    min: number;
    max: number;
    parse: (input: string) => number | string | null;
    onChange: (v: number | string) => void;
    gridClassName?: string;
}): ReactElement {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const isCustom = !editing && values.indexOf(value) === -1;
    const commit = (raw: string) => {
        setEditing(false);
        if (!raw.trim()) return;
        const next = parse(raw);
        if (next !== null && next !== value) onChange(next);
    };
    return (
        <div className={cn("grid gap-2", gridClassName || "grid-cols-5")}>
            {values.map((v) => (
                <OptionPill key={String(v)} selected={!editing && value === v} onClick={() => onChange(v)}>
                    {format(v)}
                </OptionPill>
            ))}
            {editing ? (
                <label className="col-span-1 flex h-8 items-center rounded-full border border-input">
                    <input
                        autoFocus
                        type="number"
                        min={min}
                        max={max}
                        defaultValue={String(value)}
                        className="min-w-0 w-full bg-transparent text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        onMouseDown={(event) => event.stopPropagation()}
                        onBlur={(event) => commit(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                            if (event.key === "Escape") setEditing(false);
                        }}
                    />
                </label>
            ) : (
                <OptionPill selected={isCustom} onClick={() => setEditing(true)}>
                    <span className="max-w-full overflow-hidden text-ellipsis">{isCustom ? `${t("settingsPanels.common.custom")} ${format(value)}` : t("settingsPanels.common.custom")}</span>
                </OptionPill>
            )}
        </div>
    );
}
