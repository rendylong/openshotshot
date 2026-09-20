import { useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/components/model-picker";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { buildNodeConfig } from "@/lib/canvas/node-config";
import { falModelSelectionPatch } from "@/lib/canvas/fal-settings";
import { useEffectiveConfig, useConfigStore } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { MODAL_WIDTH } from "@/lib/design/modal";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type StoryboardSettings = { metadata: Partial<CanvasNodeMetadata> };

/**
 * 生图确认弹窗（双场景共用，spec 2026-09-17 D1）：默认为分镜图生成设置；传入 title/hint/
 * promptPreview/countLocked 后复用为资产参考图生成弹窗（数量锁 1）。取消永不提交模型选择。
 */
export function GenerateStoryboardDialog({ node, count, onConfirm, onCancel, title, hint, promptPreview, maxCount, countLocked }: {
    node: CanvasNodeData;
    count: number;
    onConfirm: (settings: StoryboardSettings) => void;
    onCancel: () => void;
    /** 资产参考图场景覆盖项：缺省 = 分镜图现状行为 */
    title?: string;
    hint?: string;
    promptPreview?: string;
    maxCount?: number;
    countLocked?: boolean;
}) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [values, setValues] = useState<Partial<CanvasNodeMetadata>>(node.metadata ?? {});
    const config = buildNodeConfig(globalConfig, { ...node, metadata: values }, "image");
    const patch = (next: Partial<CanvasNodeMetadata>) => setValues((prev) => ({ ...prev, ...next }));
    return (
        <Modal open centered width={MODAL_WIDTH.sm} title={title ?? t("canvas.scriptCompose.sbSettingsTitle")}
            onCancel={onCancel} onOk={() => {
                onConfirm({ metadata: {
                ...values, model: config.model, size: config.size, quality: config.quality,
                background: config.background, count: countLocked ? 1 : Number(config.count),
            } });
            }}
            okText={t("canvas.scriptCompose.confirmGenerate")} cancelText={t("common.cancel")}
            okButtonProps={{ disabled: !config.model }}>
            <div className="flex flex-col gap-4 py-2">
                <p className="text-xs text-muted-foreground">{hint ?? t("canvas.scriptCompose.sbSettingsHint", { count })}</p>
                {promptPreview ? (
                    <div className="relative rounded-lg border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        <span className="line-clamp-2 block">{promptPreview}</span>
                        <span className="absolute bottom-1 right-2 rounded bg-background px-1 text-[9px] text-muted-foreground/70">{t("canvas.scriptAssets.promptPreviewBadge")}</span>
                    </div>
                ) : null}
                <ModelPicker config={config} capability="image" value={config.model}
                    onChange={(model) => patch(falModelSelectionPatch(config, model, values) || { model })}
                    onMissingConfig={() => openConfigDialog(true)} />
                <ImageSettingsPanel config={config} theme={theme} className="space-y-3" maxCount={maxCount} countLocked={countLocked} providerOptions={values.providerOptions}
                    onMetadataChange={patch} onConfigChange={(key, value) => patch(key === "count" ? { count: Number(value) } : { [key]: value })} />
            </div>
        </Modal>
    );
}
