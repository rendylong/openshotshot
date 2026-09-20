import { describe, expect, it } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { MANAGED_VIDEO_PROFILES, managedVideoProfile } from "@/lib/models/managed-video-profiles";
import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
import { managedVideoSpecs, resolveManagedVideoSettings } from "./managed-video-settings";

function model(id: string): ManagedModelDescriptor {
    return { id, name: id, capability: "video", execution: "remote_task", video_specs: managedVideoProfile(id)!.specs };
}
const hd = "minimax_h3_image_audio_to_video_v2";
describe("managed video profiles", () => {
    it("maps every registered default to one unique exact token", () => {
        expect(new Set(MANAGED_VIDEO_PROFILES.map(p => p.id)).size).toBe(MANAGED_VIDEO_PROFILES.length);
        for (const profile of MANAGED_VIDEO_PROFILES) {
            expect(profile.specs.filter(s => s.resolution === profile.defaultResolution)).toHaveLength(1);
            expect(new Set(profile.specs.map(s => s.resolution)).size).toBe(profile.specs.length);
        }
    });
    it("supports 1080p only on the declared workflow", () => {
        expect(managedVideoSpecs(model(hd)).map(s => s.resolution)).toContain("1080p横");
        expect(managedVideoSpecs(model("minimax_h3_lightx2v_v5_15s")).some(s => s.quality === "1080p")).toBe(false);
        expect(resolveManagedVideoSettings({ ...defaultConfig, vquality: "1080p横", videoSeconds: "10" }, model(hd))).toEqual({ resolution: "1080p横", seconds: 10 });
    });
    it("does not publish locally known specs that the gateway has not opened", () => {
        const descriptor = model(hd);
        descriptor.video_specs = descriptor.video_specs!.filter(s => s.quality !== "1080p");
        expect(managedVideoSpecs(descriptor).some(s => s.quality === "1080p")).toBe(false);
        expect(() => resolveManagedVideoSettings({ ...defaultConfig, vquality: "1080p横" }, descriptor)).toThrow();
    });
    it("uses catalog-declared specs for public aliases without inferring from the alias name", () => {
        const publicAlias = { ...model(hd), id: "video-pro" };
        expect(managedVideoSpecs(publicAlias).map(spec => spec.resolution)).toContain("1080p横");
        expect(resolveManagedVideoSettings({ ...defaultConfig, vquality: "1080p横", videoSeconds: "10" }, publicAlias)).toEqual({ resolution: "1080p横", seconds: 10 });
    });
    it("uses declared defaults only for empty settings, not legacy or partial selections", () => {
        expect(resolveManagedVideoSettings({ ...defaultConfig, vquality: "", videoSeconds: "" }, model(hd))).toEqual({ resolution: "768p竖", seconds: 5 });
        for (const vquality of ["1080p", "720", "1280x720"]) {
            expect(() => resolveManagedVideoSettings({ ...defaultConfig, vquality }, model(hd))).toThrow();
        }
    });
    it("honors the catalog duration bounds and integer flag", () => {
        const descriptor = model(hd);
        descriptor.video_specs = descriptor.video_specs!.map(s => ({ ...s, duration: { ...s.duration, max: 7, integer: false } }));
        expect(managedVideoSpecs(descriptor)[0].duration).toMatchObject({ max: 7, integer: false });
        expect(() => resolveManagedVideoSettings({ ...defaultConfig, vquality: "768p横", videoSeconds: "8" }, descriptor)).toThrow();
        expect(resolveManagedVideoSettings({ ...defaultConfig, vquality: "768p横", videoSeconds: "5.5" }, descriptor)).toEqual({ resolution: "768p横", seconds: 5.5 });
    });
});
