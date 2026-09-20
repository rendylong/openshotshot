import { useTranslation } from "react-i18next";

type Props = {
    composed: number;
    total: number;
    generatingCount: number;
    hasAnyVersion: boolean;
    onBatchGenerate: () => void;
    /** 关闭 Studio 并打开 Agent 面板（project.tsx 注入）；未注入则不渲染该入口 */
    onComposeWithAgent?: () => void;
};

/** 生成视图内容区动作条（spec D7）：动作靠近作用对象；三态互斥——可生成 / 生成中 / 重新生成。 */
export function ComposeActionsBar({ composed, total, generatingCount, hasAnyVersion, onBatchGenerate, onComposeWithAgent }: Props) {
    const { t } = useTranslation();
    const uncomposed = total - composed;
    return (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <span className="mr-auto text-xs text-muted-foreground">
                {generatingCount > 0
                    ? t("canvas.scriptCompose.generatingStatus", { count: generatingCount })
                    : t("canvas.scriptCompose.composedStatus", { done: composed, count: total })}
            </span>
            {generatingCount > 0 ? null : (
                <>
                    {uncomposed > 0 && onComposeWithAgent ? (
                        <button
                            type="button"
                            className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            onClick={onComposeWithAgent}
                        >
                            {t("canvas.scriptCompose.composeWithAgent", { count: uncomposed })}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className={`rounded-md px-4 py-2 text-sm font-semibold transition-opacity ${
                            hasAnyVersion && uncomposed === 0
                                ? "border border-border text-foreground hover:bg-secondary"
                                : "bg-foreground text-background hover:opacity-90"
                        }`}
                        onClick={onBatchGenerate}
                    >
                        {hasAnyVersion && uncomposed === 0
                            ? t("canvas.scriptCompose.regenerateAll")
                            : t("canvas.scriptCompose.batchRemaining")}
                    </button>
                </>
            )}
        </div>
    );
}
