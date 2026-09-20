import { expect, test } from "vitest";
import { parseManagedVideoSpecs } from "./managed-video-spec";
const spec = { resolution: "768p横", orientation: "landscape", quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } };
test("preserves exact specs across the IPC contract", () => { expect(parseManagedVideoSpecs([spec])).toEqual([spec]); });
test.each([undefined, [spec, spec], [{ ...spec, duration: { ...spec.duration, default: 11 } }], [{ ...spec, duration: { ...spec.duration, default: 1.5 } }], [{ ...spec, duration: { ...spec.duration, min: NaN } }], [{ ...spec, orientation: "unknown" }]])("rejects malformed spec contracts: %j", value => { expect(parseManagedVideoSpecs(value)).toBeNull(); });
