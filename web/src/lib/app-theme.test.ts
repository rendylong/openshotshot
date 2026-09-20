import { describe, expect, it } from "vitest";
import { getAntThemeConfig } from "./app-theme";
import { palette } from "./design/palette";

describe("getAntThemeConfig", () => {
    const light = getAntThemeConfig(false);
    const dark = getAntThemeConfig(true);

    it("与 stone 色板同源", () => {
        expect(light.token!.colorPrimary).toBe(palette.stone[900]);
        expect(dark.token!.colorPrimary).toBe(palette.stone[50]);
        expect(dark.token!.colorBgElevated).toBe(palette.stone[800]);
    });
    it("控件高度与圆角档位（D8/D24）", () => {
        expect(light.token!.controlHeight).toBe(32);
        expect(light.token!.borderRadius).toBe(8);
        expect(light.token!.borderRadiusLG).toBe(18);
    });
    it("状态色对齐；链接保持黑白基调（D4 + v4 用户裁定）", () => {
        expect(light.token!.colorError).toBe(palette.status.dangerLight);
        expect(light.token!.colorWarning).toBe(palette.status.warningLight);
        expect(light.token!.colorSuccess).toBe(palette.status.successLight);
        expect(light.token!.colorInfo).toBe(palette.status.infoLight);
        expect(light.token!.colorLink).toBe(palette.stone[900]);
        expect(dark.token!.colorLink).toBe(palette.stone[50]);
    });
});
