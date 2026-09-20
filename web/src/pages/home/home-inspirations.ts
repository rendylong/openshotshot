import { Box, Camera, Clapperboard, Film, Image, PanelsTopLeft, type LucideIcon } from "lucide-react";

export type HomeSceneId = "model" | "product" | "poster" | "social" | "video" | "story";

export type HomeInspiration = {
    id: string;
    promptKey: string;
};

export type HomeScene = {
    id: HomeSceneId;
    labelKey: string;
    icon: LucideIcon;
    examples: readonly HomeInspiration[];
};

const definitions = [
    ["model", Box],
    ["product", Image],
    ["poster", PanelsTopLeft],
    ["social", Camera],
    ["video", Clapperboard],
    ["story", Film],
] as const satisfies readonly [HomeSceneId, LucideIcon][];

export const HOME_SCENES: readonly HomeScene[] = definitions.map(([id, icon]) => ({
    id,
    icon,
    labelKey: `composer.inspiration.scenes.${id}`,
    examples: [0, 1, 2].map((index) => ({
        id: `${id}-${index}`,
        promptKey: `composer.inspiration.prompts.${id}.${index}`,
    })),
}));

export const HOME_RECOMMENDATIONS: readonly HomeInspiration[] = [HOME_SCENES[0].examples[0], HOME_SCENES[2].examples[0], HOME_SCENES[4].examples[1]];
