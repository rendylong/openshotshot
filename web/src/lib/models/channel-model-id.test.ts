import { describe, expect, it } from "vitest";
import { decodeChannelModel, encodeChannelModel, isChannelModelValue } from "./channel-model-id";
import * as store from "@/stores/use-config-store";

describe("shared channel model identity", () => {
    it("preserves the existing first separator and whitespace semantics", () => {
        expect(encodeChannelModel("channel", " fal-ai/flux-2-pro ")).toBe("channel::fal-ai/flux-2-pro");
        expect(decodeChannelModel("channel::model::suffix")).toEqual({ channelId: "channel", model: "model::suffix" });
        expect(decodeChannelModel("model")).toBeNull();
        expect(decodeChannelModel("::")).toEqual({ channelId: "", model: "" });
        expect(isChannelModelValue("channel::model")).toBe(true);
        expect(isChannelModelValue("model")).toBe(false);
    });
    it("keeps config store exports identical to the pure implementation", () => {
        expect(store.decodeChannelModel).toBe(decodeChannelModel);
        expect(store.encodeChannelModel).toBe(encodeChannelModel);
        expect(store.isChannelModelValue).toBe(isChannelModelValue);
    });
});
