// web/scripts/token-audit.mjs — TSX/CSS 写法闸门（D27）
// 禁止：ts/tsx 中出现 hex/rgba 字面量、任意值字号/圆角、裸调色板类。
// 白名单文件 = token 源与权威 CSS（palette/z-layers/canvas-theme/globals/aicss 过渡期）。
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const ALLOW_FILES = [/palette\.ts$/, /z-layers\.ts$/, /canvas-theme\.ts$/, /design-tokens\.test\.ts$/, /token-guard\.test\.ts$/, /globals\.css$/, /agent-aicss\.css$/, /home-project\.css$/];
const PATTERNS = [
    [/#[0-9a-fA-F]{3,8}\b/, "hex 字面量"],
    [/rgba?\(\s*\d/, "rgb(a) 字面量"],
    [/text-\[\d+(\.\d+)?(px|rem)\]/, "任意值字号"],
    [/rounded-\[[^\]]+\]/, "任意值圆角"],
    [/(?:bg|text|border)-(?:stone|gray|slate|neutral|zinc)-\d{2,3}\b/, "裸调色板类"],
    [/(?:bg|text|border|ring)-(?:red|amber|emerald|green|blue|orange|yellow|rose)-\d{2,3}\b/, "裸状态彩类"],
];
const hits = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx|css)$/.test(name) || /\.(test|spec)\.(ts|tsx)$/.test(name)) continue;
        if (ALLOW_FILES.some((re) => re.test(p))) continue;
        readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (line.includes("token-audit-ignore")) return;
            for (const [re, label] of PATTERNS) if (re.test(line)) hits.push(`${p}:${i + 1} ${label}: ${line.trim().slice(0, 120)}`);
        });
    }
})(ROOT);
// —— 基线比较：只减不增（--save-baseline 重置基线）——
const BASELINE_FILE = new URL("../.token-audit-baseline.json", import.meta.url).pathname;
if (process.argv.includes("--save-baseline")) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ total: hits.length, savedAt: new Date().toISOString() }, null, 2));
    console.log(`token-audit: baseline saved (${hits.length})`);
    process.exit(0);
}
let baseline;
try { baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")); } catch { console.error("token-audit: 缺少 .token-audit-baseline.json，先跑 --save-baseline"); process.exit(1); }
if (hits.length > baseline.total) { console.error(`token-audit: 违规 ${hits.length} > 基线 ${baseline.total}，禁止新增\n${hits.slice(0, 20).join("\n")}`); process.exit(1); }
console.log(`token-audit: ${hits.length}/${baseline.total}（存量迁移中，只减不增）`);
