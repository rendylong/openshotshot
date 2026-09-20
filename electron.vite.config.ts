import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const webSrc = fileURLToPath(new URL("./web/src", import.meta.url));

// photon-node 的 glue 在运行时用 join(__dirname, "photon_rs_bg.wasm") + readFileSync
// 加载 wasm，rolldown 无法静态分析这个动态路径，wasm 不会进入产物；pi 内置 read
// 工具的图片降采样在 wasm 缺失时对任意图片（不限大小）一律报
// "could not be resized below the inline image size limit"。构建结束后手工补入。
// wasm 必须与 bundle 内的 glue 同版本，即 pi-coding-agent 嵌套的那份 photon-node。
function copyPhotonWasm(): Plugin {
    const wasmFileName = "photon_rs_bg.wasm";
    const projectRoot = fileURLToPath(new URL(".", import.meta.url));
    const sources = [
        join(projectRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node", wasmFileName),
        join(projectRoot, "node_modules/@silvia-odwyer/photon-node", wasmFileName),
    ];
    return {
        name: "copy-photon-wasm",
        closeBundle() {
            const source = sources.find((candidate) => existsSync(candidate));
            if (!source) {
                console.warn(`[copy-photon-wasm] ${wasmFileName} not found; pi read tool will not inline images`);
                return;
            }
            // photon glue 目前在 chunk 文件内（__dirname 指向 chunks 目录），
            // 布局变化时 glue 可能内联进 index.js，两个目录都放保证命中。
            for (const dir of ["out/main", "out/main/chunks"]) {
                const targetDir = join(projectRoot, dir);
                if (existsSync(targetDir)) {
                    copyFileSync(source, join(targetDir, wasmFileName));
                }
            }
        },
    };
}

// 主进程 / preload 的产物固定为 index.js，与 package.json 的 main 及
// main.ts 里 join(__dirname, "../preload/index.js") 对齐。
// 用 rollupOptions.input 的对象 key 直接控制 chunk 名（= index），
// 并显式声明 format，绕开 electron-vite 对 lib mode 的 entry 命名规则。
function nodeConfig(entry: string, plugins: Plugin[] = []) {
    return {
        resolve: {
            alias: {
                "@": webSrc,
            },
        },
        plugins,
        build: {
            rollupOptions: {
                input: { index: entry },
                // electron 必须保持 external：打包后的 app 里 electron 由运行时提供，
                // 不能把 node_modules/electron/index.js 一起打进来（它会在运行时去找
                // 本地 dist 二进制、触发 “Downloading Electron binary...” 死循环）。
                external: [/^electron(\/.*)?$/],
                output: {
                    format: "cjs" as const,
                    entryFileNames: "[name].js",
                },
            },
        },
    };
}

export default defineConfig({
    main: nodeConfig("electron/main.ts", [copyPhotonWasm()]),
    preload: nodeConfig("electron/preload.ts"),
});
