import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FAL_ENDPOINT_IDS } from "./endpoint-ids";

const spec = readFileSync(resolve("src/lib/models/fal/endpoint-ids.spec-fixture.md"), "utf8");
const idsFrom = (text: string) => [...text.matchAll(/^\| \[`([^`]+)`\]/gm)].map((match) => match[1]);

describe("fal fixed endpoint manifest", () => {
    it("matches all 36 exact approved IDs without duplicates", () => {
        expect(FAL_ENDPOINT_IDS).toEqual(idsFrom(spec));
        expect(FAL_ENDPOINT_IDS).toHaveLength(36);
        expect(new Set(FAL_ENDPOINT_IDS).size).toBe(36);
    });

    it("keeps 12 image endpoints and 24 video endpoints", () => {
        const [images, videos] = spec.split("### 图片：12 个入口")[1].split("### 视频：24 个入口");
        expect(FAL_ENDPOINT_IDS.slice(0, 12)).toEqual(idsFrom(images));
        expect(FAL_ENDPOINT_IDS.slice(12)).toEqual(idsFrom(videos));
        expect(idsFrom(images)).toHaveLength(12);
        expect(idsFrom(videos)).toHaveLength(24);
    });
});
