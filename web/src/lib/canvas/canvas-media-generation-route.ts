import i18n from "@/i18n";
import { resolveModel } from "@/lib/models/model-resolver";
import { getMediaAdapter } from "@/services/api/media-adapters/registry";
import { DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES, DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES, resolveModelChannel, resolveModelExecution, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { RemoteMediaCapability } from "@/types/remote-media-task";

type CanvasMediaGenerationPlanInput = {
    config: AiConfig;
    capability: RemoteMediaCapability | "text";
    phase: "first" | "retry";
    pluginHost?: boolean;
};

type DirectMediaGenerationPlan = {
    mode: "direct";
    capability: RemoteMediaCapability | "text";
    phase: "first" | "retry";
};

type LegacyRemoteMediaGenerationPlan = {
    mode: "remote_task";
    capability: RemoteMediaCapability;
    phase: "first" | "retry";
    remote: NonNullable<ReturnType<typeof resolveModelExecution>>["remoteTask"] & object;
};

type AdapterRemoteMediaGenerationPlan = {
    mode: "remote_task";
    capability: RemoteMediaCapability;
    phase: "first" | "retry";
    adapterId: string;
    adapterVersion: 1;
    timeoutMinutes: number;
};

type CanvasMediaGenerationPlan = DirectMediaGenerationPlan | LegacyRemoteMediaGenerationPlan | AdapterRemoteMediaGenerationPlan;

export function planCanvasMediaGeneration(input: CanvasMediaGenerationPlanInput): CanvasMediaGenerationPlan {
    if (input.pluginHost || input.capability === "text") return { mode: "direct" as const, capability: input.capability, phase: input.phase };
    const execution = resolveModelExecution(input.config, input.config.model);
    const requestConfig = resolveModelRequestConfig(input.config, input.config.model);
    const channel = resolveModelChannel(input.config, input.config.model);
    const stored = execution?.capability;
    const resolved = resolveModel({ provider: channel.provider, baseUrl: requestConfig.baseUrl, apiFormat: requestConfig.apiFormat, model: requestConfig.model, userCapability: stored });
    const adapter = getMediaAdapter(resolved.adapterId);
    const matchesCapability = resolved.modality === input.capability || (input.capability === "audio" && (resolved.modality === "speech" || resolved.modality === "music"));
    if (resolved.execution === "remote_task" && resolved.adapterId && matchesCapability && adapter?.execution === "remote_task" && adapter.version === resolved.adapterVersion) {
        return {
            mode: "remote_task" as const,
            capability: input.capability,
            phase: input.phase,
            adapterId: resolved.adapterId,
            adapterVersion: resolved.adapterVersion,
            timeoutMinutes: input.capability === "video" ? DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES : DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES,
        };
    }

    if (execution?.executionMode === "remote_task") {
        const remote = execution.remoteTask;
        if (!remote?.submitScript.trim() || !remote.queryScript.trim()) throw new Error(i18n.t("canvas.remoteTask.invalidScripts"));
        if (!Number.isFinite(remote.timeoutMinutes) || remote.timeoutMinutes <= 0) throw new Error(i18n.t("canvas.remoteTask.invalidTimeout"));
        return { mode: "remote_task" as const, capability: input.capability, phase: input.phase, remote };
    }
    return { mode: "direct" as const, capability: input.capability, phase: input.phase };
}
