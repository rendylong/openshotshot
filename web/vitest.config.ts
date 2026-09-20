import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify("dev"),
        __APP_RELEASES__: JSON.stringify([]),
    },
    test: {
        environment: "jsdom",
        include: ["src/**/*.test.{ts,tsx}"],
        setupFiles: ["src/test/setup.ts"],
    },
});
