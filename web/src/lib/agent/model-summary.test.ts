import { describe, expect, it } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { buildAgentModelSummaries } from "./model-summary";

const config = {
    ...defaultConfig,
    channels: [
        { id: "ch-b", name: "B 渠道", provider: "fal" as const, baseUrl: "https://b.example", apiKey: "k", apiFormat: "openai" as const, models: [
            { name: "video-b", capability: "video" as const },
            { name: "img-b", capability: "image" as const },
        ] },
        { id: "ch-a", name: "A 渠道", baseUrl: "https://a.example", apiKey: "k", apiFormat: "openai" as const, models: [
            { name: "img-a", capability: "image" as const },
        ] },
    ],
    imageModel: "ch-a::img-a",
} as AiConfig;

describe("buildAgentModelSummaries", () => {
    it("展开渠道模型并按 capability→渠道→模型排序；id 为编码值、isDefault 按编码值比对", () => {
        const models = buildAgentModelSummaries(config);
        expect(models.map((m) => m.id)).toEqual(["ch-a::img-a", "ch-b::img-b", "ch-b::video-b"]);
        expect(models[0]).toMatchObject({ name: "img-a", capability: "image", channelName: "A 渠道", isDefault: true });
        expect(models.find((m) => m.id === "ch-b::video-b")?.isDefault).toBe(false);
    });

    it("无 provider 的渠道省略 provider 字段", () => {
        const models = buildAgentModelSummaries(config);
        const entry = models.find((m) => m.id === "ch-a::img-a")!;
        expect(entry.provider).toBeUndefined();
        expect("provider" in entry).toBe(false);
    });

    it("HiAPI 文生图模型在存在配对图生图模型时声明可接收可选参考图", () => {
        const hiapiConfig: AiConfig = {
            ...defaultConfig,
            channels: [{
                id: "hiapi",
                name: "HiAPI",
                provider: "hiapi",
                baseUrl: "https://api.hiapi.ai",
                apiKey: "k",
                apiFormat: "openai",
                models: [
                    { name: "gpt-image-2/text-to-image", capability: "image" },
                    { name: "gpt-image-2/image-to-image", capability: "image" },
                ],
            }],
            imageModel: "hiapi::gpt-image-2/image-to-image",
        };

        const models = buildAgentModelSummaries(hiapiConfig);

        expect(models.find((model) => model.name.endsWith("/text-to-image"))).toMatchObject({ inputMode: "text-and-image", requiresReference: false });
        expect(models.find((model) => model.name.endsWith("/image-to-image"))).toMatchObject({ inputMode: "image", requiresReference: true });
    });
});
