import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./web/src", import.meta.url)),
        },
    },
    test: {
        environment: "node",
        include: ["electron/**/*.test.ts"],
    },
});
