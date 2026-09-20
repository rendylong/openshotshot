// Usage: node scripts/design-shot.mjs <name> [section] [theme] [scroll]
// section: channels|preferences|webdav|account|local-storage; theme: dark|light; scroll: "1" bottom
import { chromium } from "/Users/apple/.npm/_npx/329f8e00b504cb4e/node_modules/playwright/index.mjs";

const [name, section = "channels", theme = "dark", scroll = "0"] = process.argv.slice(2);
const out = `/Users/apple/realicanvas/web/.gstack/design-reports/screenshots/${name}.png`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://localhost:3000/projects");
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(2000);

if (theme === "light") {
    await page.evaluate(() => localStorage.setItem("shotshot:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);
    const light = await page.evaluate(() => !document.documentElement.classList.contains("dark"));
    if (!light) { console.error("theme switch failed"); process.exit(1); }
}

// expand sidebar if collapsed
const collapse = page.getByRole("button", { name: "折叠侧栏" });
if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(500); }

// open settings popover
await page.getByRole("button", { name: "设置" }).first().click();
await page.waitForTimeout(600);
// click the config entry in the popover
await page.getByRole("button", { name: /配置/ }).first().click();
const dialog = page.locator("[data-slot=dialog-content]");
await dialog.waitFor({ state: "visible", timeout: 8000 });
await page.waitForTimeout(1200);

const labels = { preferences: "偏好设置", webdav: "WebDAV", account: "账户与订阅", "local-storage": "本地存储" };
if (section !== "channels") {
    const label = labels[section] || section;
    await dialog.locator("nav button", { hasText: label }).first().click();
    await page.waitForTimeout(800);
    const active = await dialog.locator("nav button[aria-current]").textContent();
    if (!active || active.trim() !== label) { console.error(`nav switch failed: got ${active}, want ${label}`); process.exit(1); }
}
if (scroll === "1") {
    await dialog.locator("[data-radix-scroll-area-viewport]").evaluate((v) => { v.scrollTop = v.scrollHeight; });
    await page.waitForTimeout(400);
}
const box = await dialog.boundingBox();
if (!box) { console.error("dialog not found"); process.exit(1); }
await page.screenshot({ path: out, clip: box });
await browser.close();
console.log(`saved ${out} (${Math.round(box.width)}x${Math.round(box.height)})`);
