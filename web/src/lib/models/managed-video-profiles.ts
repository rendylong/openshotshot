import { AUTODL_WORKFLOWS } from "./autodl-workflows";
import type { ManagedVideoSpec } from "@/lib/desktop/managed-video-spec";

// Exact public workflow tokens. Labels never determine the submitted value.
const TOKENS: Record<string, Pick<ManagedVideoSpec, "quality" | "orientation">> = Object.fromEntries([
    ...["480p", "736p", "768p", "1080p"].flatMap(quality => [
        [`${quality}横`, { quality, orientation: "landscape" as const }],
        [`${quality}竖`, { quality, orientation: "portrait" as const }],
        [`${quality}(1:1)`, { quality, orientation: "square" as const }],
    ]),
    ["832*464px(横版)", { quality: "832×464", orientation: "landscape" as const }],
    ["464*832px(竖版)", { quality: "464×832", orientation: "portrait" as const }],
]);

export type ManagedVideoProfile = {
    id: string;
    defaultResolution: string;
    specs: ManagedVideoSpec[];
};

// Managed aliases currently use the exact workflow ID. Unknown aliases are not guessed.
// Workflows without a duration are not executable via the current managed video API.
const WORKFLOW_PROFILES: readonly ManagedVideoProfile[] = AUTODL_WORKFLOWS
    .filter(workflow => workflow.duration)
    .map(workflow => ({
        id: workflow.id,
        defaultResolution: workflow.resolution.default,
        specs: workflow.resolution.options.map(resolution => {
            const token = TOKENS[resolution];
            if (!token) throw new Error(`Unsupported managed video token: ${resolution}`);
            const { min, max, default: defaultSeconds, integer } = workflow.duration!;
            return { resolution, ...token, duration: { min, max, default: defaultSeconds, integer } };
        }),
    }));

// These managed-only workflows share the reviewed 15s quality/orientation contract.
// Keep their exact IDs; this is not name-based capability inference.
export const MANAGED_VIDEO_PROFILES: readonly ManagedVideoProfile[] = [
    ...WORKFLOW_PROFILES,
    ...["minimax_h3_zm_u24", "minimax_h3_zm_u08"].map(id => ({
        ...WORKFLOW_PROFILES.find(profile => profile.id === "minimax_h3_lightx2v_v5_15s")!, id,
    })),
];

export function managedVideoProfile(modelId: string | undefined) {
    return MANAGED_VIDEO_PROFILES.find(profile => profile.id === modelId);
}
