import { describe, expect, it, vi } from "vitest";
vi.mock("localforage", () => ({default: {createInstance: () => ({getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn()})}}));
import { parseAiSourcePreferences } from "./ai-source-preferences";
describe("AI source preferences", () => {
    it("accepts an agent ChatGPT selection without an API key", () => {
        expect(parseAiSourcePreferences({version: 1, selections: {agent: {source: "chatgpt", modelId: "model"}}}).selections.agent?.source).toBe("chatgpt");
    });
    it.each([
        {version: 2, selections: {}},
        {version: 1, selections: {image: {source: "chatgpt", modelId: "model"}}},
        {version: 1, selections: {agent: {source: "chatgpt", modelId: "model", apiKey: "secret"}}},
        {version: 1, selections: {other: {source: "chatgpt", modelId: "model"}}},
        {version: 1, selections: {agent: {source: "platform", modelId: "model"}}},
    ])("rejects unsupported or secret-bearing configuration", (value) => expect(() => parseAiSourcePreferences(value)).toThrow());
});
