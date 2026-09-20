import type { ResolvedModel } from "@/lib/models/model-adapter-types";

import { falImageAdapter, falVideoAdapter } from "./fal";
import { zhipuImageAdapter, zhipuVideoAdapter } from "./glm";
import { minimaxImageAdapter, minimaxMusicAdapter, minimaxSpeechAdapter, minimaxVideoAdapter } from "./minimax";
import { geminiImageAdapter, geminiSpeechAdapter, geminiVideoAdapter, openAIImageAdapter, openAISpeechAdapter, openAIVideoAdapter } from "./openai-gemini";
import { hiapiAudioAdapter, hiapiImageAdapter, hiapiMusicAdapter, hiapiVideoAdapter } from "./hiapi";
import { managedImageAdapter } from "./managed-image";
import type { MediaAdapter } from "./types";

import { autodlVideoAdapter } from "./autodl";

const adapters = new Map<string, MediaAdapter>();

export function assertMediaAdapterRegistry(registry: readonly MediaAdapter[]): void {
    const ids = new Set<string>();

    for (const adapter of registry) {
        if (ids.has(adapter.id)) {
            throw new Error(`duplicate media adapter: ${adapter.id}`);
        }
        ids.add(adapter.id);

        if (adapter.execution === "remote_task" && (!adapter.submit || !adapter.query)) {
            throw new Error(`remote_task adapter ${adapter.id} must implement submit and query`);
        }
        if (adapter.execution === "direct" && !adapter.generate) {
            throw new Error(`direct adapter ${adapter.id} must implement generate`);
        }
    }
}

export function registerMediaAdapters(registry: readonly MediaAdapter[]): void {
    assertMediaAdapterRegistry(registry);
    adapters.clear();
    for (const adapter of registry) {
        adapters.set(adapter.id, adapter);
    }
}

export function getMediaAdapter(adapterId: ResolvedModel["adapterId"]): MediaAdapter | undefined {
    if (!adapterId) {
        return undefined;
    }
    return adapters.get(adapterId);
}

registerMediaAdapters([
    falImageAdapter,
    falVideoAdapter,
    autodlVideoAdapter,
    minimaxImageAdapter,
    minimaxVideoAdapter,
    minimaxSpeechAdapter,
    minimaxMusicAdapter,
    zhipuImageAdapter,
    zhipuVideoAdapter,
    openAIImageAdapter,
    openAISpeechAdapter,
    openAIVideoAdapter,
    geminiImageAdapter,
    geminiSpeechAdapter,
    geminiVideoAdapter,
    hiapiImageAdapter,
    hiapiVideoAdapter,
    hiapiAudioAdapter,
    hiapiMusicAdapter,
    managedImageAdapter,
]);
