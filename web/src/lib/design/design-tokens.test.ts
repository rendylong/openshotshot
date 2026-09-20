import { describe, expect, it } from "vitest";
import { palette } from "./palette";
import { Z_LAYERS } from "./z-layers";

describe("palette", () => {
    it("stone 阶完整且为标准 Tailwind stone 值", () => {
        expect(palette.stone[300]).toBe("#d6d3d1");
        expect(palette.stone[800]).toBe("#292524");
        expect(palette.stone[900]).toBe("#1c1917");
        expect(Object.keys(palette.stone)).toHaveLength(11);
    });
    it("状态色为 AA 深档（spec §4.4）", () => {
        expect(palette.status.warningLight).toBe("#b45309");
        expect(palette.status.successLight).toBe("#15803d");
        expect(palette.status.dangerLight).toBe("#dc2626");
        expect(palette.status.infoLight).toBe("#2563eb");
    });
    it("画布表面为半透明毛玻璃值", () => {
        expect(palette.canvas.surfaceLight).toBe("rgba(255,255,255,.96)");
        expect(palette.canvas.surfaceDark).toBe("rgba(31,29,26,.96)");
    });
});

describe("z-layers", () => {
    it("阶梯严格递增", () => {
        const values = Object.values(Z_LAYERS);
        for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    });
});
