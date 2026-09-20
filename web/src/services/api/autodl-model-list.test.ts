import axios from "axios";
import { afterEach, expect, test, vi } from "vitest";
import { AUTODL_WORKFLOWS } from "@/lib/models/autodl-workflows";
import { createModelChannel } from "@/stores/use-config-store";
import { fetchChannelModels } from "./image";

afterEach(() => vi.restoreAllMocks());

test.each([
    { provider: "autodl", baseUrl: "https://proxy.example.test", apiFormat: "gemini" },
    { provider: "custom", baseUrl: "https://autodl.art", apiFormat: "openai" },
    { provider: "custom", baseUrl: "https://www.autodl.art/api/v1", apiFormat: "openai" },
] as const)("lists AutoDL builtins without HTTP for $baseUrl", async (config) => {
    const get = vi.spyOn(axios, "get").mockRejectedValue(new Error("unexpected network"));
    await expect(fetchChannelModels(createModelChannel(config))).resolves.toEqual(AUTODL_WORKFLOWS.map(({ id }) => id));
    expect(get).not.toHaveBeenCalled();
});
