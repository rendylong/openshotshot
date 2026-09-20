import { describe, expect, it } from "vitest";

import { isAssetRefToken, parseAssetRefToken, serializeProjectAssetToken } from "./asset-ref-token";

const ref = { backend: "project-file" as const, projectId: "-hIsYsRl4N1fXK9rbVk8c", assetId: "798ce8e7-b944-493b-a18d-6e688a57ce6f", revision: 1, relativePath: "assets/generated/images/asset-25J5COPD.png" };

describe("asset-ref-token", () => {
    it("round-trip", () => {
        expect(parseAssetRefToken(serializeProjectAssetToken(ref))).toEqual(ref);
    });
    it("relativePath 特殊字符（冒号/中文/空格）round-trip", () => {
        const weird = { ...ref, relativePath: "assets/场 景:图 v2.png" };
        expect(parseAssetRefToken(serializeProjectAssetToken(weird))).toEqual(weird);
    });
    it("拒绝畸形输入", () => {
        expect(isAssetRefToken("image:abc")).toBe(false);
        expect(parseAssetRefToken("pfile:")).toBeUndefined();
        expect(parseAssetRefToken("pfile:p:a:notanumber:x")).toBeUndefined();
        expect(parseAssetRefToken("pfile:p:a:1:%zz")).toBeUndefined(); // 非法 percent-encoding
    });
});
