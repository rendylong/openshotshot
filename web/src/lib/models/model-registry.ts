import { listFalProfiles } from "./fal/profiles";
import type { ModelRule, ProviderId } from "./model-adapter-types";

import { AUTODL_WORKFLOWS } from "./autodl-workflows";

export const MODEL_RULES: readonly ModelRule[] = [
    ...listFalProfiles().map((profile): ModelRule => ({ provider: "fal", models: [profile.endpointId], result: { modality: profile.modality, execution: "remote_task", adapterId: `fal.${profile.modality}` } })),
    { provider: "autodl", models: AUTODL_WORKFLOWS.map(({ id }) => id), result: { modality: "video", execution: "remote_task", adapterId: "autodl.video" } },
    ...(["minimax-cn", "minimax-global"] as const).flatMap((provider): ModelRule[] => [
        { provider, models: ["image-01", "image-01-live"], result: { modality: "image", execution: "direct", adapterId: "minimax.image" } },
        { provider, pattern: /^(?:minimax-)?hailuo-[\w.-]+$/i, result: { modality: "video", execution: "remote_task", adapterId: "minimax.video" } },
        { provider, pattern: /^minimax-h\d+[\w.-]*$/i, result: { modality: "video", execution: "remote_task", adapterId: "minimax.video" } },
        { provider, pattern: /^speech-[\w.-]+$/i, result: { modality: "speech", execution: "direct", adapterId: "minimax.speech" } },
        { provider, models: ["music-2.6"], result: { modality: "music", execution: "direct", adapterId: "minimax.music" } },
        { provider, models: ["minimax-m2.7", "minimax-m2.7-highspeed"], result: { modality: "text", execution: "stream", adapterId: "openai-compatible.text" } },
    ]),
    { provider: "zhipu", models: ["glm-image"], result: { modality: "image", execution: "remote_task", adapterId: "zhipu.image" } },
    { provider: "zhipu", models: ["cogvideox-3"], result: { modality: "video", execution: "remote_task", adapterId: "zhipu.video" } },
    { provider: "zhipu", pattern: /^cogvideox(?:-[\w.-]+)?$/i, result: { modality: "video", execution: "remote_task", adapterId: "zhipu.video" } },
    { provider: "moonshot", models: ["kimi-k2.5"], result: { modality: "text", execution: "stream", adapterId: "openai-compatible.text" } },
    { provider: "deepseek", models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"], result: { modality: "text", execution: "stream", adapterId: "openai-compatible.text" } },
    { provider: "openai", pattern: /^gpt-image-[\w.-]+$/i, result: { modality: "image", execution: "direct", adapterId: "openai.image" } },
    { provider: "openai", pattern: /^dall-e-[\w.-]+$/i, result: { modality: "image", execution: "direct", adapterId: "openai.image" } },
    { provider: "openai", pattern: /^gpt-[\w.-]+-tts$/i, result: { modality: "speech", execution: "direct", adapterId: "openai.speech" } },
    { provider: "openai", pattern: /^sora-[\w.-]+$/i, result: { modality: "video", execution: "remote_task", adapterId: "openai.video" } },
    { provider: "gemini", pattern: /^(?:gemini-[\w.-]+-image|imagen-[\w.-]+)$/i, result: { modality: "image", execution: "direct", adapterId: "gemini.image" } },
    { provider: "gemini", pattern: /^gemini-[\w.-]+-tts$/i, result: { modality: "speech", execution: "direct", adapterId: "gemini.speech" } },
    { provider: "gemini", pattern: /^veo-[\w.-]+$/i, result: { modality: "video", execution: "remote_task", adapterId: "gemini.video" } },
    {
        provider: "hiapi",
        models: [
            "gpt-image-2/text-to-image", "gpt-image-2/image-to-image", "grok-imagine/text-to-image", "grok-imagine/image-to-image",
            "grok-imagine-image-2.0/text-to-image", "grok-imagine-image-2.0/image-to-image", "grok-imagine-quality/text-to-image", "grok-imagine-quality/image-to-image",
            "seedream-4.5/text-to-image", "seedream-4.5/image-to-image", "seedream-5.0-lite/text-to-image", "seedream-5.0-lite/image-to-image",
            "seedream-5.0-pro/text-to-image", "seedream-5.0-pro/image-to-image", "nano-banana", "nano-banana-2", "nano-banana-2-lite", "nano-banana-pro",
            "flux-2-klein-4b/text-to-image", "flux-2-klein-4b/image-to-image", "flux-2-klein-9b/text-to-image", "flux-2-klein-9b/image-to-image",
            "flux-2/text-to-image", "flux-2/image-to-image", "flux-1.1-pro", "flux-schnell/text-to-image", "qwen-image-2.0", "qwen-image-2.0-pro",
            "qwen-image-3.0/text-to-image", "qwen-image-3.0/image-to-image", "qwen-image-3.0-pro/text-to-image", "qwen-image-3.0-pro/image-to-image",
            "z-image", "wan2.7-image/text-to-image", "ideogram-v4",
        ],
        pattern: /^(?:gpt-image-2|grok-imagine(?:-image-2\.0|-quality)?|seedream-[\w.-]+|nano-banana(?:-[\w.-]+)?|flux-(?!3(?:$|@))[\w.-]+|qwen-image-[\w.-]+|z-image|wan2\.7-image|ideogram-v4)(?:\/(?:text-to-image|image-to-image))?(?:@(?:default|beta|ext))?$/i,
        result: { modality: "image", execution: "remote_task", adapterId: "hiapi.image" },
    },
    {
        provider: "hiapi",
        models: [
            "veo-3.1/text-to-video", "veo-3.1/image-to-video", "veo-3.1-fast/text-to-video", "veo-3.1-fast/image-to-video",
            "seedance-2.0", "seedance-2.0-mini", "seedance-2.0-fast", "seedance-2.5/text-to-video", "seedance-2.5/image-to-video", "seedance-2.5/reference-to-video",
            "gemini-omni-flash/text-to-video", "gemini-omni-flash/image-to-video", "gemini-omni-flash/reference-to-video", "flux-3", "grok-imagine/text-to-video", "grok-imagine/image-to-video", "grok-imagine-1.5/image-to-video",
            "happyhorse-1.0", "happyhorse-1.1/text-to-video", "happyhorse-1.1/image-to-video", "happyhorse-1.1/reference-to-video", "heygen-avatar-v", "hailuo-2.3/text-to-video", "hailuo-2.3/image-to-video", "hailuo-2.3-fast/image-to-video", "minimax-h3",
            "kling-3.0-turbo/text-to-video", "kling-3.0-turbo/image-to-video", "kling-3.0-omni/text-to-video", "kling-3.0-omni/image-to-video", "wan3.0-video", "wan2.7-video/text-to-video", "wan2.7-video/image-to-video",
        ],
        pattern: /^(?:veo-[\w.-]+|seedance-[\w.-]+|gemini-omni-flash|flux-3|grok-imagine(?:-[\w.-]+)?|happyhorse-[\w.-]+|heygen-avatar-v|hailuo-[\w.-]+|minimax-h3|kling-[\w.-]+|wan(?:2\.7-video|3\.0-video))(?:\/(?:text-to-video|image-to-video|reference-to-video))?$/i,
        result: { modality: "video", execution: "remote_task", adapterId: "hiapi.video" },
    },
    {
        provider: "hiapi",
        models: ["elevenlabs/text-to-dialogue", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"],
        pattern: /^(?:elevenlabs\/text-to-dialogue|qwen-audio-3\.0-tts-(?:plus|flash))$/i,
        result: { modality: "speech", execution: "remote_task", adapterId: "hiapi.speech" },
    },
    { provider: "hiapi", models: ["minimax-music-1.5", "minimax-music-2.6", "minimax-music-3"], pattern: /^minimax-music-[\w.-]+$/i, result: { modality: "music", execution: "remote_task", adapterId: "hiapi.music" } },
];

const OFFICIAL_HOSTS: Readonly<Record<string, ProviderId>> = {
    "api.minimaxi.com": "minimax-cn",
    "api.minimax.io": "minimax-global",
    "api.deepseek.com": "deepseek",
    "api.moonshot.cn": "moonshot",
    "open.bigmodel.cn": "zhipu",
    "api.openai.com": "openai",
    "queue.fal.run": "fal",
    "openrouter.ai": "openrouter",
    "generativelanguage.googleapis.com": "gemini",
    "api.hiapi.ai": "hiapi",
    "autodl.art": "autodl",
    "www.autodl.art": "autodl",
};

export function providerFromOfficialBaseUrl(baseUrl: string): ProviderId | undefined {
    try {
        return OFFICIAL_HOSTS[new URL(baseUrl.trim()).hostname.toLowerCase()];
    } catch {
        return undefined;
    }
}
