import { readFileSync } from "node:fs";
// jsdom 环境的全局 URL 不支持 file: base；且 vite 会把白名单全局名 URL 视作全局引用，
// 必须用别名引入 Node 原生 URL，否则 new URL 仍解析到 http://localhost:3000
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

import { palette } from "./palette";
import { canvasThemes } from "@/lib/canvas-theme";

function cssBlock(selector: ":root" | ".dark"): Record<string, string> {
    const css = readFileSync(new NodeURL("../../styles/globals.css", import.meta.url), "utf8");
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`block ${selector} not found（globals.css 选择器格式必须为 "${selector} {"）`);
    const end = css.indexOf("}", start);
    const body = css.slice(start, end);
    const vars: Record<string, string> = {};
    for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = norm(m[2].trim());
    return vars;
}

/** 归一化空白与 0.x 前导零，使 "rgba(255, 255, 255, 0.96)" 与 "rgba(255,255,255,.96)" 相等 */
function norm(value: string): string {
    return value.replace(/\s+/g, "").replace(/([(,])0\./g, "$1.");
}

describe("globals.css ↔ palette 一致性（spec §8.3）", () => {
    const root = cssBlock(":root");
    const dark = cssBlock(".dark");

    it("基础语义变量重锚 stone", () => {
        expect(root["border"]).toBe(palette.stone[300]);
        expect(root["foreground"]).toBe(palette.stone[900]);
        expect(dark["background"]).toBe(palette.stone[900]);
        expect(dark["popover"]).toBe(palette.stone[800]);
        expect(dark["card"]).toBe(palette.stone[800]);
    });
    it("状态色与 palette 相等", () => {
        expect(root["danger"]).toBe(palette.status.dangerLight);
        expect(root["warning"]).toBe(palette.status.warningLight);
        expect(root["success"]).toBe(palette.status.successLight);
        expect(root["info"]).toBe(palette.status.infoLight);
        expect(dark["danger"]).toBe(palette.status.dangerDark);
        expect(dark["warning"]).toBe(palette.status.warningDark);
        expect(dark["success"]).toBe(palette.status.successDark);
        expect(dark["info"]).toBe(palette.status.infoDark);
    });
    it("画布桥变量：surface 半透明、dot 与 canvasThemes.dot 同源", () => {
        expect(root["canvas-surface"]).toBe(palette.canvas.surfaceLight);
        expect(dark["canvas-surface"]).toBe(palette.canvas.surfaceDark);
        expect(root["canvas-dot"]).toBe(palette.canvas.dotLight);
        expect(dark["canvas-dot"]).toBe(palette.canvas.dotDark);
    });
    it("destructive 与 danger 同值", () => {
        expect(root["destructive"]).toBe(root["danger"]);
        expect(dark["destructive"]).toBe(dark["danger"]);
    });
    it("--canvas-hover/-active 与 canvasThemes hover 值同源", () => {
        expect(root["canvas-hover"]).toBe(palette.stone[200]); // = canvasThemes.light.toolbar.itemHover
        expect(dark["canvas-hover"]).toBe(palette.stone[800]);
        expect(dark["canvas-active"]).toBe("#3a3631"); // canvasThemes.dark.toolbar.activeBg（登记的非刻度值）
    });
});

describe("canvasThemes ↔ palette 一致性（spec §5）", () => {
    it("描边/hover/文字与 stone 阶对齐", () => {
        expect(canvasThemes.light.node.stroke).toBe(palette.stone[300]);
        expect(canvasThemes.light.toolbar.border).toBe(palette.stone[300]);
        expect(canvasThemes.light.node.muted).toBe(palette.stone[500]);
        expect(canvasThemes.light.toolbar.itemHover).toBe(palette.stone[200]);
        expect(canvasThemes.dark.node.stroke).toBe(palette.stone[700]);
        expect(canvasThemes.dark.node.fill).toBe(palette.stone[800]);
    });
    it("画布表面/点阵与 palette.canvas 相等", () => {
        expect(canvasThemes.light.toolbar.panel).toBe(palette.canvas.surfaceLight);
        expect(canvasThemes.dark.toolbar.panel).toBe(palette.canvas.surfaceDark);
        expect(canvasThemes.light.canvas.dot).toBe(palette.canvas.dotLight);
        expect(canvasThemes.dark.canvas.dot).toBe(palette.canvas.dotDark);
    });
});
