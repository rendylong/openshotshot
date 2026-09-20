import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { videoModelSelectionPatch } from "@/components/video-settings-panel";
import { CanvasVideoSettingsPopover } from "../canvas-video-settings-popover";
import { buildNodeConfig, videoConfigPatch } from "@/lib/canvas/node-config";
import { falModelSelectionPatch } from "@/lib/canvas/fal-settings";
import { useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type ShotVideoSettings = Partial<CanvasNodeMetadata>;

type Props = {
    open: boolean;
    mode: "generate" | "regenerate";
    shotNo: number;
    versionNo?: number;
    node?: CanvasNodeData;
    onConfirm: (settings: ShotVideoSettings) => void;
    onCancel: () => void;
};

/** 生成设置确认弹窗（spec D12）：与视频节点面板同款的模型/尺寸控件；确认后整体写入镜头视频节点再触发生成。 */
export function GenerateVideoDialog({ open, mode, shotNo, versionNo, node, onConfirm, onCancel }: Props) {
    const { t } = useTranslation();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const globalConfig = useEffectiveConfig();
    const config = useMemo(() => (node ? buildNodeConfig(globalConfig, node, "video") : globalConfig), [globalConfig, node]);

    // 弹窗内累积的 metadata 级设置（与画布面板同一套 patch 语义）；确认时整体交给 project.tsx 写入节点
    const [values, setValues] = useState<ShotVideoSettings>({});
    useEffect(() => {
        if (open) setValues({});
    }, [open, node?.id]);

    const dialogModel = values.model;

    const displayConfig: AiConfig = useMemo(
        () => ({
            ...config,
            ...(dialogModel ? { model: dialogModel } : {}),
            ...(values.size ? { size: values.size } : {}),
            ...(values.seconds ? { videoSeconds: values.seconds } : {}),
            ...(values.vquality ? { vquality: values.vquality } : {}),
            ...(values.generateAudio ? { videoGenerateAudio: values.generateAudio } : {}),
            ...(values.watermark ? { videoWatermark: values.watermark } : {}),
        }),
        [config, values, dialogModel],
    );

    return (
        <Modal
            title={`${t(mode === "regenerate" ? "canvas.scriptCompose.regenerateVideo" : "canvas.scriptCompose.generateVideo")} · ${t("canvas.scriptCompose.videoSettingsTitle")}${mode === "regenerate" && versionNo ? ` · V${versionNo}` : ""}`}
            open={open}
            onCancel={onCancel}
            footer={null}
            destroyOnHidden
            width={460}
        >
            <div className="flex flex-col gap-3 pt-1">
                <div className="text-xs text-muted-foreground">{t("canvas.scriptCompose.videoSettingsHint", { no: shotNo })}</div>
                <div className="flex min-w-0 items-center gap-2">
                    <ModelPicker
                        config={displayConfig}
                        value={displayConfig.model}
                        capability="video"
                        className="h-9 min-w-0 max-w-[200px] rounded-lg border-border bg-transparent px-2"
                        currentLabel={displayConfig.model}
                        onChange={(model) => setValues((prev) => ({ ...prev, ...(falModelSelectionPatch(displayConfig, model, { ...node?.metadata, ...values }) || videoModelSelectionPatch(displayConfig, model)) }))}
                        onMissingConfig={() => openConfigDialog(true)}
                    />
                    <CanvasVideoSettingsPopover
                        config={displayConfig}
                        providerOptions={values.providerOptions ?? node?.metadata?.providerOptions}
                        onMetadataChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
                        onConfigChange={(key, value) => setValues((prev) => ({ ...prev, ...videoConfigPatch(key, value) }))}
                        buttonClassName="!h-9 !max-w-none !rounded-lg !px-2.5"
                    />
                </div>
                <div className="mt-1 flex justify-end gap-2">
                    <button type="button" className="rounded-lg border border-border px-3.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent" onClick={onCancel}>
                        {t("canvas.scriptCompose.cancelDialog")}
                    </button>
                    <button
                        type="button"
                        className="rounded-lg bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                        onClick={() => onConfirm({ ...values })}
                    >
                        {t(mode === "regenerate" ? "canvas.scriptCompose.confirmRegenerate" : "canvas.scriptCompose.confirmGenerate")}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
