import { encodeChannelModel } from "@/lib/models/channel-model-id";
import type { AiConfig, ModelCapability, ModelChannel } from "@/stores/use-config-store";

import type { AgentModelSummary } from "./pi-agent-types";

const CAPABILITY_ORDER: ModelCapability[] = ["image", "video", "audio", "text"];

/** 组装 agent 可读的实际执行目录摘要（Phase 2 推送载荷，spec D9/D11）：
    BYOK id 为 encodeChannelModel 编码值，agent 逐字传回；
    isDefault 对应该能力当前实际默认模型。
    纯函数：renderer 组装推送、主进程不引入 config store。 */
function byokImageContract(channel: ModelChannel, name: string): Pick<AgentModelSummary, "inputMode" | "requiresReference"> {
    if (/\/(?:image-to-image|image-edit)$/i.test(name)) return { inputMode: "image", requiresReference: true };
    if (/\/text-to-image$/i.test(name)) {
        const paired = name.replace(/\/text-to-image$/i, "/image-to-image");
        const supportsOptionalReference = channel.provider === "hiapi" && channel.models.some((model) => model.name === paired);
        return { inputMode: supportsOptionalReference ? "text-and-image" : "text", requiresReference: false };
    }
    return { inputMode: "unknown", requiresReference: false };
}

export function buildAgentModelSummaries(config: AiConfig): AgentModelSummary[] {
    const defaultByCapability: Record<ModelCapability, string> = {
        image: config.imageModel,
        video: config.videoModel,
        audio: config.audioModel,
        text: config.textModel,
    };
    return config.channels
        .flatMap((channel) => channel.models
            .map((model) => {
                const id = encodeChannelModel(channel.id, model.name);
                return {
                    id,
                    name: model.name,
                    capability: model.capability,
                    channelName: channel.name,
                    ...(channel.provider ? { provider: channel.provider } : {}),
                    ...(model.capability === "image" ? byokImageContract(channel, model.name) : {}),
                    isDefault: defaultByCapability[model.capability] === id,
                };
            }))
        .sort((a, b) =>
            CAPABILITY_ORDER.indexOf(a.capability) - CAPABILITY_ORDER.indexOf(b.capability)
            || a.channelName.localeCompare(b.channelName)
            || a.name.localeCompare(b.name),
        );
}
