import { buildImageGenerationMetadata, copyImageGenerationMetadata } from "./canvas-node-factory";
import { compileFalInput } from "@/lib/models/fal/input";
import { falSettingsParams } from "./fal-settings";
import { describe, expect, it } from "vitest";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { listFalProfiles, getFalProfile } from "@/lib/models/fal/profiles";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildNodeConfig } from "./node-config";
import { buildGenerationConfig } from "./canvas-generation-helpers";
import { falDefaultMetadata, falModelSelectionPatch, validateFalSettings } from "./fal-settings";
const profiles = listFalProfiles();
const config: AiConfig = { ...defaultConfig, model: "fal::fal-ai/kling-video/v3/pro/text-to-video", channels: [{ id: "fal", name: "fal.ai", provider: "fal", baseUrl: "https://queue.fal.run", apiKey: "", apiFormat: "openai", models: profiles.map(profile => ({ name: profile.id, capability: profile.modality })) }] };
const node: CanvasNodeData = { id: "new", type: CanvasNodeType.Video, title: "Video", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { model: config.model } };
it("initializes new Kling nodes from the profile including audio off", () => {
    expect(falDefaultMetadata(config)).toEqual({ model: config.model, seconds: "5", size: "16:9", generateAudio: "false" });
});
it("display and generation preserve explicit invalid choices, with profile defaults only when absent", () => {
    for (const build of [buildNodeConfig, buildGenerationConfig]) {
        expect(build(config, node, "video")).toMatchObject({ videoSeconds: "5", size: "16:9", videoGenerateAudio: "false" });
        expect(build(config, { ...node, metadata: { ...node.metadata, seconds: "99", size: "bad", generateAudio: "true" } }, "video")).toMatchObject({ videoSeconds: "99", size: "bad", videoGenerateAudio: "true" });
    }
});
it("keeps five seconds when switching Kling to Veo until an explicit valid choice", () => {
    const model = "fal::fal-ai/veo3.1";
    const patch = falModelSelectionPatch({ ...config, videoSeconds: "5", size: "16:9", videoGenerateAudio: "true" }, model)!;
    expect(patch).toMatchObject({ model, seconds: "5", generateAudio: "true" });
    expect(patch).not.toHaveProperty("providerOptions");
    expect(() => validateFalSettings(getFalProfile("fal-ai/veo3.1")!, buildNodeConfig({ ...config, model }, { ...node, metadata: patch }, "video"))).toThrow("fal_input_invalid");
});
describe("all exact fal new-node defaults", () => {
    it.each(profiles.map(profile => [profile.id, profile] as const))("%s compiles through display and generation configs", (_id, profile) => {
        const selected = { ...config, model: `fal::${profile.id}` };
        const target = { ...node, metadata: falDefaultMetadata(selected) };
        expect(() => validateFalSettings(profile, buildNodeConfig(selected, target, profile.modality))).not.toThrow();
        expect(() => validateFalSettings(profile, buildGenerationConfig(selected, target, profile.modality))).not.toThrow();
    });
});
it("does not promote unused generic resolution into an explicit value on model switch", () => {
    const model = "fal::fal-ai/veo3.1";
    expect(falModelSelectionPatch({ ...config, vquality: "720", videoSeconds: "5" }, model, { model: config.model })).toMatchObject({ seconds: "5", vquality: "720p" });
    expect(falModelSelectionPatch(config, model, { model: config.model, vquality: "bad", generateAudio: "true" })).toMatchObject({ vquality: "bad", generateAudio: "true" });
});

it.each(["generation", "edit"] as const)("preserves 4K through %s output, copy, reopen and subsequent compiled generation", type => {
    const endpoint = type === "edit" ? "fal-ai/nano-banana-2/edit" : "fal-ai/nano-banana-2";
    const profile = getFalProfile(endpoint)!;
    const selected = { ...config, imageModel: `fal::${endpoint}`, model: `fal::${endpoint}` };
    const reference = { id: "source", name: "Source", type: "image/png", dataUrl: "https://example.com/source.png" };
    const source = { ...node, type: CanvasNodeType.Image, metadata: { model: selected.model, vquality: "4K" } };
    const output = buildImageGenerationMetadata(type, buildGenerationConfig(selected, source, "image"), 1, type === "edit" ? [reference] : []);
    const reopened = { ...source, metadata: JSON.parse(JSON.stringify(copyImageGenerationMetadata({ ...output, remoteTask: { id: "original", status: "failed", submittedAt: 1 } }))) };
    expect(reopened.metadata).toMatchObject({ vquality: "4K", model: selected.model });
    expect(reopened.metadata).not.toHaveProperty("remoteTask");
    for (const build of [buildNodeConfig, buildGenerationConfig]) {
        const next = build(selected, reopened, "image");
        expect(compileFalInput(profile, { prompt: "Product", images: type === "edit" ? [reference.dataUrl] : [], params: falSettingsParams(profile, next) })).toMatchObject({ resolution: "4K" });
        const invalid = build(selected, { ...reopened, metadata: { ...reopened.metadata, vquality: "invalid" } }, "image");
        expect(invalid.vquality).toBe("invalid");
        expect(() => validateFalSettings(profile, invalid)).toThrow("fal_input_invalid");
    }
});
