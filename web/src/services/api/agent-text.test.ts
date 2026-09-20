import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentTitleUnsupportedSourceError, requestAgentTextCompletion } from "@/services/api/agent-text";
import type { AiTextMessage } from "@/services/api/image";

const { resolveMock, imageQuestionMock } = vi.hoisted(() => ({ resolveMock: vi.fn(), imageQuestionMock: vi.fn() }));

vi.mock("@/lib/agent/text-model-config", () => ({ resolvePiModelConfigForBridge: resolveMock }));
vi.mock("@/services/api/image", () => ({ requestImageQuestion: imageQuestionMock }));

const messages: AiTextMessage[] = [{ role: "user", content: "hi" }];

afterEach(() => {
    delete window.shotshot;
    resolveMock.mockReset();
    imageQuestionMock.mockReset();
});

describe("requestAgentTextCompletion", () => {
    test("byok：用 Agent 解析出的模型合成 config.model 转发 requestImageQuestion", async () => {
        resolveMock.mockResolvedValue({ source: "byok", model: "agent-x", baseUrl: "https://x", apiKey: "k", apiFormat: "openai", agentApiMode: "chat_completions", supportsImageInput: false });
        imageQuestionMock.mockResolvedValue("回答");
        const answer = await requestAgentTextCompletion(messages);
        expect(answer).toBe("回答");
        expect(imageQuestionMock).toHaveBeenCalledWith(expect.objectContaining({ model: "agent-x" }), messages, expect.any(Function), expect.objectContaining({}));
    });

    test("chatgpt 源：抛错（调用方回退截断）", async () => {
        resolveMock.mockResolvedValue({ source: "chatgpt", model: "gpt" });
        await expect(requestAgentTextCompletion(messages)).rejects.toThrow(/chatgpt/);
    });

    test("解析为 null：抛错（调用方回退截断）", async () => {
        resolveMock.mockResolvedValue(null);
        await expect(requestAgentTextCompletion(messages)).rejects.toThrow(AgentTitleUnsupportedSourceError);
    });
});
