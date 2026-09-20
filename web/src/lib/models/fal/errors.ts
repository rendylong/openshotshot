import i18n from "@/i18n";

/** Presentation only: never changes the original Error, transport code or abort reason. */
export function formatFalGenerationError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^(fal_[a-z_\d-]+)(?::|$)/.exec(message);
    if (!match) return message;
    const token = match[1];
    const http = /^fal_http_(\d+)$/.exec(token);
    const key = http ? "http" : token.startsWith("fal_transport_") ? "transport"
        : token.startsWith("fal_model_") ? "model" : token.startsWith("fal_options_") ? "options"
        : ({ fal_mask_unsupported: "mask", fal_target_unsupported: "target", fal_network_error: "network", fal_channel_invalid: "channel", fal_output_invalid: "output", fal_missing_request_id: "queue", fal_invalid_queue_status: "queue", fal_request_failed: "request", fal_media_read_failed: "mediaRead", fal_media_bytes: "mediaBytes", fal_media_type: "mediaType", fal_media_dimensions: "mediaDimensions", fal_media_ratio: "mediaRatio", fal_missing_reference: "references", fal_extra_references: "references", fal_unsupported_media: "references" } as Record<string, string>)[token] || "input";
    return `${i18n.t(`falGenerationErrors.${key}`, { status: http?.[1] })} (${token})`;
}
