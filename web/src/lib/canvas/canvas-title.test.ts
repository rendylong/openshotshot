import { beforeEach, describe, expect, test, vi } from "vitest";

import { canvasTitleFromPrompt, generateCanvasTitle, sanitizeGeneratedTitle } from "@/lib/canvas/canvas-title";
import { requestAgentTextCompletion } from "@/services/api/agent-text";

vi.mock("@/services/api/agent-text", () => ({ requestAgentTextCompletion: vi.fn() }));

const requestAgentTextCompletionMock = vi.mocked(requestAgentTextCompletion);

beforeEach(() => {
    vi.clearAllMocks();
});

describe("canvasTitleFromPrompt", () => {
    test("keeps short prompts as-is after trimming", () => {
        expect(canvasTitleFromPrompt("  帮我做一张 iPhone 广告图  ")).toBe("帮我做一张 iPhone 广告图");
    });

    test("truncates long prompts to 40 chars with ellipsis", () => {
        const long = "一".repeat(60);
        expect(canvasTitleFromPrompt(long)).toBe(`${"一".repeat(40)}…`);
        expect(canvasTitleFromPrompt("一".repeat(40))).toHaveLength(40);
    });

    test("falls back when the prompt is empty", () => {
        expect(canvasTitleFromPrompt("   ", "photo.png")).toBe("photo.png");
        expect(canvasTitleFromPrompt("   ")).toBe("");
    });
});

describe("sanitizeGeneratedTitle", () => {
    test("strips quotes, prefixes and trailing punctuation", () => {
        expect(sanitizeGeneratedTitle("「科技感 iPhone 广告图」")).toBe("科技感 iPhone 广告图");
        expect(sanitizeGeneratedTitle("标题：星际探索海报")).toBe("星际探索海报");
        expect(sanitizeGeneratedTitle('"Galaxy Poster"。')).toBe("Galaxy Poster");
    });

    test("drops reasoning blocks and picks the first non-empty line", () => {
        expect(sanitizeGeneratedTitle("<think>分析一下……</think>\n\n星舰启航")).toBe("星舰启航");
        expect(sanitizeGeneratedTitle("第一行标题\n第二行解释")).toBe("第一行标题");
    });

    test("caps the length and rejects empty answers", () => {
        expect(sanitizeGeneratedTitle("一".repeat(40))).toBe(`${"一".repeat(30)}…`);
        expect(sanitizeGeneratedTitle("  \n  ")).toBeNull();
        expect(sanitizeGeneratedTitle("<think>只有思考</think>")).toBeNull();
    });
});

describe("generateCanvasTitle", () => {
    test("routes through the Agent text model resolver", async () => {
        requestAgentTextCompletionMock.mockResolvedValue("「星舰启航」");

        await expect(generateCanvasTitle("帮我做一张星际海报")).resolves.toBe("星舰启航");

        const [messages] = requestAgentTextCompletionMock.mock.calls[0];
        expect(messages).toEqual([{ role: "user", content: expect.stringContaining("创作请求：帮我做一张星际海报") }]);
    });

    test("sanitizes the title returned by the Agent text model", async () => {
        requestAgentTextCompletionMock.mockResolvedValue("科技感海报");

        await expect(generateCanvasTitle("帮我做一张 iPhone 广告图")).resolves.toBe("科技感海报");

        expect(requestAgentTextCompletionMock).toHaveBeenCalledTimes(1);
    });

    test("returns null when the Agent text request fails", async () => {
        requestAgentTextCompletionMock.mockRejectedValue(new Error("model_unavailable"));

        await expect(generateCanvasTitle("帮我做一张星际海报")).resolves.toBeNull();
    });

    test("returns null for empty questions without any request", async () => {
        await expect(generateCanvasTitle("   ")).resolves.toBeNull();

        expect(requestAgentTextCompletionMock).not.toHaveBeenCalled();
    });
});
