import { afterEach, expect, test } from "vitest";
import i18n from "@/i18n";
import { formatFalGenerationError } from "./errors";
afterEach(() => i18n.changeLanguage("zh-CN"));
test.each(["zh-CN", "en-US"])("localizes submit and queue failures in %s without leaking details", async language => {
    await i18n.changeLanguage(language);
    for (const token of ["fal_http_422", "fal_transport_body", "fal_network_error", "fal_channel_invalid", "fal_model_schema-incompatible", "fal_output_invalid", "fal_options_version", "fal_input_invalid", "fal_missing_reference", "fal_media_read_failed"]) {
        const error = Object.assign(new Error(`${token}: data:image/png;base64,SECRET fixture-key`), { code: "ERR_NETWORK" });
        const message = formatFalGenerationError(error);
        expect(message).not.toBe(error.message);
        expect(message).toContain(token);
        expect(message).not.toContain("SECRET"); expect(message).not.toContain("fixture-key");
        expect(error.code).toBe("ERR_NETWORK");
    }
    expect(formatFalGenerationError(new Error("existing user error"))).toBe("existing user error");
});
