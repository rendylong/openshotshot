export type AutodlMediaKind = "image" | "audio" | "video";
export type AutodlWorkflow = {
    id: string;
    labelKey: string;
    prompt?: { minLength: number; maxLength: number };
    duration?: { field: "duration" | "audio_duration"; integer: boolean; min: number; max: number; default: number };
    resolution: { options: readonly string[]; default: string };
    media: readonly { field: string; kind: AutodlMediaKind; required: boolean; acceptTypes: readonly string[] }[];
};

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const AUDIO_TYPES = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/flac"] as const;
const VIDEO_TYPES = ["video/mp4", "video/webm"] as const;

// Reviewed public input contracts. Field order defines the zero-based reference slot within each media kind.
// No server node mappings, executable payload templates, or internal sample files are retained.
export const AUTODL_WORKFLOWS: readonly AutodlWorkflow[] = [
    {
        id: "minimax_h3_b99_002",
        labelKey: "autodl.workflows.b99Frames",
        prompt: { minLength: 1, maxLength: 10000 },
        duration: { field: "duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["736p竖", "736p横", "736p(1:1)"], default: "736p竖" },
        media: [
            { field: "first_frame", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "last_frame", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
        ],
    },
    {
        id: "minimax_h3_b99_001",
        labelKey: "autodl.workflows.b99Text",
        prompt: { minLength: 1, maxLength: 10000 },
        duration: { field: "duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["736p竖", "736p横", "736p(1:1)"], default: "736p竖" },
        media: [
        ],
    },
    {
        id: "minimax_h3_b99_003_12s",
        labelKey: "autodl.workflows.b99Images12",
        prompt: { minLength: 1, maxLength: 10000 },
        duration: { field: "duration", integer: true, min: 1, max: 12, default: 5 },
        resolution: { options: ["736p竖", "736p横", "736p(1:1)"], default: "736p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_1", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_2", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_3", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_4", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_5", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_6", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_7", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_8", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
        ],
    },
    {
        id: "wan2.2animate-v4-motion_retargeting",
        labelKey: "autodl.workflows.motionRetargeting",
        resolution: { options: ["464*832px(竖版)", "832*464px(横版)"], default: "464*832px(竖版)" },
        media: [
            { field: "ref_image", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "ref_video", kind: "video", required: true, acceptTypes: VIDEO_TYPES },
        ],
    },
    {
        id: "minimax_h3_image_audio_to_video_v2_15s",
        labelKey: "autodl.workflows.imagesAudio15",
        prompt: { minLength: 1, maxLength: 10000 },
        duration: { field: "duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "480p横", "768p横"], default: "768p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_1", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_2", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_3", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_4", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_5", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_6", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_7", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_8", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_audio_0", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_1", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_2", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
        ],
    },
    {
        id: "minimax_h3_lightx2v_v5_15s",
        labelKey: "autodl.workflows.images15",
        prompt: { minLength: 1, maxLength: 500000 },
        duration: { field: "duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)"], default: "768p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_1", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_2", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_3", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_4", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_5", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_6", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_7", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_8", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
        ],
    },
    {
        id: "minimax_h3_image_audio_to_video_v2",
        labelKey: "autodl.workflows.imagesAudio",
        prompt: { minLength: 1, maxLength: 10000 },
        duration: { field: "duration", integer: true, min: 1, max: 10, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"], default: "768p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_1", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_2", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_3", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_4", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_5", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_6", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_7", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_8", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_audio_0", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_1", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_2", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
        ],
    },
    {
        id: "minimax_h3_image_audio_to_video",
        labelKey: "autodl.workflows.lipSync",
        duration: { field: "audio_duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"], default: "768p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "ref_audio_0", kind: "audio", required: true, acceptTypes: AUDIO_TYPES },
        ],
    },
    {
        id: "minimax_h3_lightx2v_v5",
        labelKey: "autodl.workflows.images",
        prompt: { minLength: 1, maxLength: 500000 },
        duration: { field: "duration", integer: true, min: 1, max: 10, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"], default: "768p竖" },
        media: [
            { field: "ref_image_0", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_1", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_2", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_3", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_4", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_5", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_6", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_7", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_image_8", kind: "image", required: false, acceptTypes: IMAGE_TYPES },
            { field: "ref_audio_0", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_1", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
            { field: "ref_audio_2", kind: "audio", required: false, acceptTypes: AUDIO_TYPES },
        ],
    },
    {
        id: "minimax_h3_lightx2v_no_pic",
        labelKey: "autodl.workflows.text",
        prompt: { minLength: 1, maxLength: 200000 },
        duration: { field: "duration", integer: true, min: 1, max: 15, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)"], default: "768p竖" },
        media: [
        ],
    },
    {
        id: "minimax_h3_lightx2v",
        labelKey: "autodl.workflows.frames",
        prompt: { minLength: 1, maxLength: 2000000 },
        duration: { field: "duration", integer: false, min: 1, max: 15, default: 5 },
        resolution: { options: ["480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)"], default: "768p竖" },
        media: [
            { field: "first_frame", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
            { field: "last_frame", kind: "image", required: true, acceptTypes: IMAGE_TYPES },
        ],
    },
];

export function getAutodlWorkflow(id: string): AutodlWorkflow | undefined {
    return AUTODL_WORKFLOWS.find((workflow) => workflow.id === id);
}
