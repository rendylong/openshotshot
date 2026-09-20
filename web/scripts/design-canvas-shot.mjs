// Canvas UI design-review capture harness.
// Usage: node scripts/design-canvas-shot.mjs
// Projects are created through the app UI (store persist only flushes in the app realm);
// seeded nodes are injected by rewriting shotshot:canvas_store in IDB before a hard reload.
import { chromium } from "/Users/apple/.npm/_npx/329f8e00b504cb4e/node_modules/playwright/index.mjs";

import { rmSync, readdirSync } from "node:fs";
const OUT = "/Users/apple/realicanvas/.gstack/design-reports/screenshots";
const BASE = "http://127.0.0.1:3000";
for (const f of readdirSync(OUT)) if (f.startsWith("canvas-")) rmSync(`${OUT}/${f}`);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
const failures = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

async function click(loc, label, timeout = 5000) {
    try {
        await loc.click({ timeout });
    } catch {
        try {
            await loc.click({ timeout, force: true });
            failures.push(`force-click: ${label}`);
        } catch (e) {
            failures.push(`${label}: ${(e.message || e).split("\n")[0]}`);
        }
    }
}

// Create a project through the app's own dialog; the app navigates to the canvas.
async function uiCreateProject(title) {
    await page.goto(`${BASE}/projects`);
    await page.waitForTimeout(2200);
    await click(page.getByRole("button", { name: "新建项目" }).first(), "新建项目");
    await page.waitForTimeout(900);
    await page.getByPlaceholder("项目名称").fill(title);
    await page.locator(".ant-modal").getByRole("button", { name: /创\s*建/ }).click();
    await page.waitForTimeout(3500);
    const url = new URL(page.url());
    const parts = url.pathname.split("/");
    if (url.pathname.startsWith("/canvas") && parts[2] && parts[3]) return { projectId: parts[2], canvasId: parts[3] };
    failures.push(`uiCreateProject(${title}) landed on ${page.url()}`);
    return null;
}

// Close the agent panel if present (aria may be the raw i18n key before the fix lands).
async function closeAgentPanel() {
    const btn = page.locator('[aria-label="agent.closeAgent"], [aria-label="收起 Agent"]');
    for (let i = 0; i < 3; i++) {
        if (!(await btn.count())) return;
        await click(btn.first(), "收起 Agent");
        await page.waitForTimeout(1000);
    }
}

const TEXT = "分镜创意：黄昏列车驶过城市高架，主角倚窗回望。风格：电影感暖色调，浅景深。";

// --- project A: empty canvas (first impression, as shipped) ---
await page.goto(`${BASE}/projects`);
await page.waitForTimeout(2200);
const a = await uiCreateProject("评审·空画布");
if (a) {
    await page.waitForTimeout(1500);
    await shot(page, "canvas-01-empty-first-impression");
}

// --- project B: app-created shell + IDB-injected nodes ---
const b = await uiCreateProject("评审·节点画布");
if (b) {
    // Leave the canvas page first: its beforeunload persist would clobber the injection.
    await page.goto(`${BASE}/projects`);
    await page.waitForTimeout(1500);
    // Rewrite canvas_store with seeded nodes, using the app-written project as the shell.
    await page.evaluate(async ({ pid, cid, text }) => {
        const { createCanvasNode } = await import("/src/lib/canvas/canvas-node-factory.ts");
        const c = document.createElement("canvas");
        c.width = 832; c.height = 520;
        const g = c.getContext("2d");
        const grad = g.createLinearGradient(0, 0, 0, 520);
        grad.addColorStop(0, "#fde68a"); grad.addColorStop(0.55, "#f97316"); grad.addColorStop(1, "#7c2d12");
        g.fillStyle = grad; g.fillRect(0, 0, 832, 520);
        g.fillStyle = "#fef3c7"; g.beginPath(); g.arc(620, 150, 70, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#431407"; g.fillRect(0, 340, 832, 180);
        g.fillStyle = "#5c230c"; g.beginPath(); g.moveTo(0, 340); g.lineTo(260, 180); g.lineTo(470, 340); g.closePath(); g.fill();
        g.fillStyle = "#3b1006"; g.beginPath(); g.moveTo(300, 340); g.lineTo(560, 210); g.lineTo(832, 340); g.closePath(); g.fill();
        const png = c.toDataURL("image/png");
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open("shotshot");
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        const row = await new Promise((res, rej) => {
            const tx = db.transaction("app_state", "readonly");
            const rq = tx.objectStore("app_state").get("shotshot:canvas_store");
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
        });
        const raw = typeof row === "string" ? row : JSON.stringify(row);
        const value = JSON.parse(raw);
        const project = value.state.projects.find((p) => p.id === pid);
        const canvas = project.canvases.find((c) => c.id === cid);
        canvas.nodes = [
            createCanvasNode("image", { x: -420, y: -120 }, { content: png, status: "success", naturalWidth: 832, naturalHeight: 520, prompt: "黄昏列车驶过城市高架，电影感暖色调" }),
            createCanvasNode("text", { x: 260, y: -200 }, { content: text }),
            createCanvasNode("script", { x: -140, y: 330 }),
            createCanvasNode("image", { x: 460, y: 280 }),
        ];
        const nextRaw = JSON.stringify(value);
        await new Promise((res, rej) => {
            const tx = db.transaction("app_state", "readwrite");
            const rq = tx.objectStore("app_state").put(nextRaw, "shotshot:canvas_store");
            rq.onsuccess = () => res();
            rq.onerror = () => rej(rq.error);
        });
    }, { pid: b.projectId, cid: b.canvasId, text: TEXT });

    await page.goto(`${BASE}/canvas/${b.projectId}/${b.canvasId}`);
    await page.waitForTimeout(3000);
    // Always fit-view first so screenshots reflect the user's natural view of the canvas.
    await click(page.getByRole("button", { name: "重置视图" }), "重置视图");
    await page.waitForTimeout(900);
    await shot(page, "canvas-02-nodes-with-agent");

    await closeAgentPanel();
    await shot(page, "canvas-03-nodes-full");

    // selected image node + hover toolbar
    await page.locator("[data-node-id]").first().click();
    await page.waitForTimeout(700);
    await shot(page, "canvas-04-image-selected");

    // add-node popover
    await click(page.getByRole("button", { name: "添加节点" }), "添加节点");
    await page.waitForTimeout(600);
    await shot(page, "canvas-05-add-node-popover");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // node context menu
    await page.locator("[data-node-id]").first().click({ button: "right" });
    await page.waitForTimeout(600);
    await shot(page, "canvas-06-node-context-menu");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // resources drawer
    await click(page.getByRole("button", { name: "画布资源" }), "画布资源");
    await page.waitForTimeout(1200);
    await shot(page, "canvas-07-resources-drawer");
    for (let i = 0; i < 3; i++) {
        if (!(await page.locator("aside", { hasText: "画布资源" }).count())) break;
        await click(page.getByRole("button", { name: "关闭画布资源" }).first(), "关闭画布资源");
        await page.waitForTimeout(1200);
    }
    if (await page.locator("aside", { hasText: "画布资源" }).count()) failures.push("resources drawer still open after 3 close attempts");

    // minimap
    await click(page.getByRole("button", { name: "打开小地图" }), "打开小地图");
    await page.waitForTimeout(800);
    await shot(page, "canvas-08-minimap");
    await click(page.getByRole("button", { name: "关闭小地图" }).first(), "关闭小地图");
    await page.waitForTimeout(500);

    // appearance popover
    await click(page.getByRole("button", { name: "画布外观" }), "画布外观");
    await page.waitForTimeout(600);
    await shot(page, "canvas-09-appearance-popover");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // --- light theme ---
    await page.evaluate(() => localStorage.setItem("shotshot:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
    await page.reload();
    await page.waitForTimeout(3000);
    const reset2 = page.getByRole("button", { name: "重置视图" });
    if (await reset2.count()) { await click(reset2, "重置视图2"); await page.waitForTimeout(900); }
    await shot(page, "canvas-11-light-nodes");
    await page.locator("[data-node-id]").first().click();
    await page.waitForTimeout(700);
    await shot(page, "canvas-12-light-image-selected");
}

// --- DOM metrics (Phase 2 extraction) ---
const metrics = await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].slice(0, 600);
    const fonts = [...new Set(els.map((e) => getComputedStyle(e).fontFamily))];
    const colors = [...new Set(els.flatMap((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]).filter((c) => c && c !== "rgba(0, 0, 0, 0)"))];
    const small = [...document.querySelectorAll("a,button,input,[role=button]")]
        .map((e) => ({ tag: e.tagName, label: e.getAttribute("aria-label") || (e.textContent || "").trim().slice(0, 20), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }))
        .filter((e) => e.w > 0 && (e.w < 44 || e.h < 44));
    return { fonts, colorCount: colors.length, colors: colors.slice(0, 40), undersizedTargets: small.slice(0, 30) };
});
console.log(JSON.stringify({ metrics, errors, failures }, null, 2));
await browser.close();
console.log("done");
