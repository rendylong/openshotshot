import { Pin, RotateCcw } from "lucide-react";
import { message } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** 生成面板统一默认 footer（D2/D3/D15/D16）：安静文本按钮；禁用判定由调用方按 D3 拆分传入。 */
export function GenerationDefaultsFooter({ typeName, summary, canSet, canReset, onSetDefault, onReset, className }: {
    typeName: string;
    summary: string;
    canSet: boolean;
    canReset: boolean;
    onSetDefault: () => void;
    onReset: () => void;
    className?: string;
}) {
    const { t } = useTranslation();
    return (
        <div className={cn("mt-3 border-t border-border pt-2.5", className)}>
            <div className="mb-1.5 text-xs text-muted-foreground">
                {t("settingsPanels.common.defaultSummary", { summary })}
            </div>
            <div className="-mx-2 flex items-center gap-0.5">
                <button
                    type="button"
                    title={t("settingsPanels.common.resetParamsTitle")}
                    disabled={!canReset}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    onClick={() => {
                        onReset();
                        message.success(t("settingsPanels.common.resetToast"));
                    }}
                >
                    <RotateCcw className="size-3" />
                    {t("settingsPanels.common.resetParams")}
                </button>
                <button
                    type="button"
                    title={t("settingsPanels.common.setAsDefaultTitle")}
                    disabled={!canSet}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                    onClick={() => {
                        onSetDefault();
                        message.success(t("settingsPanels.common.setDefaultToast", { type: typeName, summary }));
                    }}
                >
                    <Pin className="size-3" />
                    {t("settingsPanels.common.setAsDefault")}
                </button>
            </div>
        </div>
    );
}
