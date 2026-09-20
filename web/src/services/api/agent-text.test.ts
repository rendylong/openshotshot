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
        resolveMock.mockResolvedValue({ credentialMode: "byok", model: "agent-x", baseUrl: "https://x", apiKey: "k", apiFormat: "openai", agentApiMode: "chat_completions", supportsImageInput: false });
        imageQuestionMock.mockResolvedValue("回答");
        const answer = await requestAgentTextCompletion(messages);
        expect(answer).toBe("回答");
        expect(imageQuestionMock).toHaveBeenCalledWith(expect.objectContaining({ model: "agent-x" }), messages, expect.any(Function), expect.objectContaining({}));
    });

    test("shotshot：走托管 /v1/chat/completions 并解析 choices", async () => {
        resolveMock.mockResolvedValue({ credentialMode: "shotshot", model: "managed-text", apiFormat: "openai", agentApiMode: "chat_completions" });
        const fetchMock = vi.fn(async (_request: unknown) => ({ status: 200, headers: {}, body: { kind: "text", value: JSON.stringify({ choices: [{ message: { content: "标题" } }] }) } }));
        window.shotshot = { managedModels: { fetch: fetchMock, abort: vi.fn(), listModels: vi.fn() } } as never;
        const answer = await requestAgentTextCompletion(messages);
        expect(answer).toBe("标题");
        expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/chat/completions", timeoutClass: "text" }));
        const request = fetchMock.mock.calls[0]?.[0] as { body?: { value?: string } };
        expect(JSON.parse(request.body?.value ?? "").model).toBe("managed-text");
    });

    test("chatgpt 源：抛错（调用方回退截断）", async () => {
        resolveMock.mockResolvedValue({ source: "chatgpt", model: "gpt" });
        await expect(requestAgentTextCompletion(messages)).rejects.toThrow(/chatgpt/);
    });

    test("platform 源：同样抛错回退", async () => {
        resolveMock.mockResolvedValue({ source: "platform", model: "gpt" });
        await expect(requestAgentTextCompletion(messages)).rejects.toThrow(/platform/);
    });

    test("content 为分段数组时拼接文本", async () => {
        resolveMock.mockResolvedValue({ credentialMode: "shotshot", model: "managed-text", apiFormat: "openai", agentApiMode: "chat_completions" });
        const fetchMock = vi.fn(async () => ({ status: 200, headers: {}, body: { kind: "text", value: JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "标" }, { type: "text", text: "题" }] } }] }) } }));
        window.shotshot = { managedModels: { fetch: fetchMock, abort: vi.fn(), listModels: vi.fn() } } as never;
        await expect(requestAgentTextCompletion(messages)).resolves.toBe("标题");
    });

    test("解析为 null：抛错（调用方回退截断）", async () => {
        resolveMock.mockResolvedValue(null);
        await expect(requestAgentTextCompletion(messages)).rejects.toThrow(AgentTitleUnsupportedSourceError);
    });
});
