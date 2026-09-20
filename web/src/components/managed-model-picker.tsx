import { ModelPicker } from "@/components/model-picker";
import { useManagedCatalog } from "@/lib/desktop/use-managed-catalog";
import { credentialModeFor, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useTranslation } from "react-i18next";

type CapabilityModelPickerProps = {
    config: AiConfig;
    capability: ModelCapability;
    /** BYOK 模式的受控值（channel::model 编码 id）；托管分支忽略。 */
    value: string;
    /** 节点/控件显式选择的托管目录 id；托管分支显示时优先，缺省或不在目录时回退套餐偏好。 */
    nodeModel?: string;
    /** 两种模式统一回调：托管分支传回目录 id，落点（节点 metadata 等）由调用方决定。 */
    onChange: (model: string) => void;
    className?: string;
    fullWidth?: boolean;
    currentLabel?: string;
    onMissingConfig?: () => void;
};

// 方案 A（spec 2026-09-12-canvas-managed-model-picker-design）+ 方向 A 修订（2026-09-18）：按能力凭据模式分流。
// 托管分支的选择语义 = 节点级受控选择（与 BYOK 一致）：显示与回调都以 nodeModel 优先，
// 套餐默认偏好（managedModels[capability]，偏好设置页维护）只作缺省回退；
// 生成侧 buildGenerationConfig 会把节点显式目录 id 钉进请求偏好，保证"选什么下次生成就用什么"。
export function CapabilityModelPicker({ config, capability, value, nodeModel, onChange, className, fullWidth, currentLabel, onMissingConfig }: CapabilityModelPickerProps) {
    const { t } = useTranslation();
    const catalog = useManagedCatalog();
    if (credentialModeFor(config, capability) !== "shotshot") {
        return <ModelPicker config={config} value={value} onChange={onChange} capability={capability} className={className} fullWidth={fullWidth} currentLabel={currentLabel} onMissingConfig={onMissingConfig} />;
    }
    const models = (catalog?.models ?? []).filter((model) => model.capability === capability);
    // remote_task image models now run through the managed image adapter, so every catalog entry is selectable.
    const selectableModels = models;
    if (selectableModels.length) {
        const byNode = nodeModel ? selectableModels.find((model) => model.id === nodeModel) : undefined;
        const effective = byNode ?? selectableModels.find((model) => model.id === config.managedModels[capability]) ?? selectableModels[0]!;
        return (
            <ModelPicker
                config={config}
                value={effective.id}
                currentLabel={effective.name}
                capability={capability}
                extraOnly
                extraOptionsHeader={t("config.managed.catalogTitle", { capability: t(`config.credentialMode.capabilities.${capability}`), count: selectableModels.length })}
                extraOptions={selectableModels.map((model) => ({ value: model.id, label: model.name }))}
                onChange={onChange}
                className={className}
                fullWidth={fullWidth}
            />
        );
    }
    // 目录尚未成功水合（无桌面桥接或首次读取失败）时保持中性文案：
    // 读不到目录不等于套餐缺少该能力，不能误报 missingCapability。
    const label = !catalog || catalog.status === "error"
        ? t("config.managed.provided")
        : capability === "audio"
            ? t("config.managed.audioNotProvided")
            : t("config.managed.missingCapability", { capability: t(`config.credentialMode.capabilities.${capability}`) });
    return (
        <span
            className={`inline-flex min-w-0 items-center truncate text-muted-foreground ${className ?? ""}`}
            title={label}
        >
            <span className="min-w-0 truncate">{label}</span>
        </span>
    );
}
