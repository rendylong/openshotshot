import i18n from "@/i18n";
import { queryMiniMaxVideo, requestMiniMaxImages, requestMiniMaxMusic, requestMiniMaxSpeech, submitMiniMaxVideo } from "@/services/api/minimax";

import type { MediaAdapter } from "./types";

export const minimaxImageAdapter: MediaAdapter = {
    id: "minimax.image",
    version: 1,
    modality: "image",
    execution: "direct",
    generate: async ({ config, prompt, images, params, signal }) => {
        if (params.mask) throw new Error(i18n.t("apiErrors.maskModelUnsupported"));
        const requestedCount = Number(params.count ?? config.count);
        const systemPrompt = config.systemPrompt.trim();
        const sources = await requestMiniMaxImages(config, systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, images, requestedCount, signal);
        return { kind: "image", sources };
    },
};

export const minimaxVideoAdapter: MediaAdapter = {
    id: "minimax.video",
    version: 1,
    modality: "video",
    execution: "remote_task",
    submit: async ({ config, prompt, images, params, signal }) => {
        if (!prompt.trim()) throw new Error(i18n.t("apiErrors.minimaxPromptRequired"));
        return submitMiniMaxVideo(config, prompt, images, params, signal);
    },
    query: async ({ config, taskId, signal }) => queryMiniMaxVideo(config, taskId, signal),
};

export const minimaxSpeechAdapter: MediaAdapter = {
    id: "minimax.speech",
    version: 1,
    modality: "speech",
    execution: "direct",
    generate: async ({ config, prompt, params, signal }) => {
        const format = typeof params.format === "string" ? params.format : config.audioFormat;
        const speed = Number(params.speed ?? config.audioSpeed);
        const voice = typeof params.voice === "string" ? params.voice : config.audioVoice;
        const source = await requestMiniMaxSpeech({ ...config, audioVoice: voice }, prompt, format, speed, signal);
        return { kind: "audio", source, mimeType: source.type };
    },
};

export const minimaxMusicAdapter: MediaAdapter = {
    id: "minimax.music",
    version: 1,
    modality: "music",
    execution: "direct",
    generate: async ({ config, prompt, params, signal }) => {
        const source = await requestMiniMaxMusic(config, prompt, params, signal);
        return { kind: "audio", source, mimeType: "audio/mpeg" };
    },
};
