import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export type MemorySectionProps = {
    title: string;
    hint: string;
    budget: number;
    value: string;
    disabled?: boolean;
    disabledHint?: string;
    onChange: (next: string) => void;
};

export function MemorySection({ title, hint, budget, value, disabled, disabledHint, onChange }: MemorySectionProps) {
    const { t } = useTranslation();
    const over = value.length > budget;
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{title}</span>
                <span className={cn("text-xs", over ? "text-red-500" : "text-stone-400")}>{value.length} / {budget}</span>
            </div>
            <p className="text-xs text-stone-400 dark:text-stone-500">{disabled ? disabledHint : hint}</p>
            <textarea
                value={value}
                onChange={(event) => onChange(event.target.value)}
                disabled={disabled}
                aria-label={title}
                spellCheck={false}
                className="min-h-40 w-full resize-y rounded-lg border border-stone-200 bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-stone-900 outline-none transition focus:border-stone-500 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-400 dark:border-stone-700 dark:text-stone-100 dark:disabled:bg-stone-900"
            />
            {over && !disabled ? <p className="text-xs text-red-500">{t("agent.memory.overBudget")}</p> : null}
        </div>
    );
}
