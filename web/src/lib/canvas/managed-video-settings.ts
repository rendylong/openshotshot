import i18n from "@/i18n";
import type { AiConfig } from "@/stores/use-config-store";
import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
import { managedVideoProfile } from "@/lib/models/managed-video-profiles";
import { parseManagedVideoSpecs } from "@/lib/desktop/managed-video-spec";

export function managedVideoSpecs(model?: ManagedModelDescriptor) {
    // The public model ID is an operator-managed alias and is not required to
    // equal the upstream workflow ID. The gateway derives these specs from the
    // routed workflow plus active price rows, so they are the executable truth.
    return parseManagedVideoSpecs(model?.video_specs) ?? [];
}

/** Never infer a provider spec from the public alias or silently change resolution. */
export function resolveManagedVideoSettings(config: AiConfig, model?: ManagedModelDescriptor) {
    const specs = managedVideoSpecs(model);
    if (!specs.length) throw new Error(i18n.t("settingsPanels.video.managedUnavailable"));
    const spec = selectedManagedVideoSpec(config, model);
    if (!spec) throw new Error(i18n.t("settingsPanels.video.managedChooseSpec"));
    const seconds = config.videoSeconds.trim() ? Number(config.videoSeconds) : spec.duration.default;
    const d = spec.duration;
    if (!Number.isFinite(seconds) || seconds < d.min || seconds > d.max || (d.integer && !Number.isInteger(seconds))) {
        throw new Error(i18n.t("settingsPanels.video.managedDuration", { min: d.min, max: d.max }));
    }
    return { resolution: spec.resolution, seconds };
}

/** Empty new configuration may use the declared default; partial/legacy values never do. */
export function selectedManagedVideoSpec(config: AiConfig, model?: ManagedModelDescriptor) {
    const token = config.vquality || managedVideoProfile(model?.id)?.defaultResolution;
    return managedVideoSpecs(model).find(spec => spec.resolution === token);
}
