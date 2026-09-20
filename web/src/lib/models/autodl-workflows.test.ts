import { describe, expect, test } from "vitest";
import snapshot from "./autodl-workflows.contracts.json";
import { AUTODL_WORKFLOWS, getAutodlWorkflow } from "./autodl-workflows";

describe("AutoDL built-in workflow contracts", () => {
    test("contains exactly the eleven researched video workflow IDs", () => {
        expect(AUTODL_WORKFLOWS).toHaveLength(11);
        expect(AUTODL_WORKFLOWS.map(({ id }) => id)).toEqual(snapshot.workflows.map(({ id }) => id));
        expect(getAutodlWorkflow("future-workflow")).toBeUndefined();
    });

    test.each(snapshot.workflows)("preserves official input constraints for $id", ({ id, inputRules }) => {
        const workflow = getAutodlWorkflow(id)!;
        const rules = inputRules as unknown as Record<string, { type: string; min?: number; max?: number; default?: unknown; min_length?: number; max_length?: number; options?: string[]; required: boolean; accept_types?: string[] }>;
        expect(workflow).toBeDefined();
        const duration = rules.duration || rules.audio_duration;
        expect(workflow.duration).toEqual(duration ? { field: rules.duration ? "duration" : "audio_duration", integer: duration.type === "integer", min: duration.min, max: duration.max, default: duration.default } : undefined);
        expect(workflow.prompt).toEqual(rules.prompt ? { minLength: rules.prompt.min_length, maxLength: rules.prompt.max_length } : undefined);
        expect(workflow.resolution).toEqual({ options: rules.resolution.options, default: rules.resolution.default });
        expect(workflow.resolution.options).toContain(workflow.resolution.default);
        for (const kind of ["image", "audio", "video"]) {
            expect(workflow.media.filter((slot) => slot.kind === kind)).toEqual(Object.entries(rules).filter(([, rule]) => rule.type === kind).map(([field, rule]) => ({ field, kind, required: rule.required, acceptTypes: rule.accept_types })));
        }
        expect(workflow.labelKey).toMatch(/^autodl\.workflows\.[a-zA-Z0-9]+$/);
        expect(JSON.stringify(workflow)).not.toMatch(/node_id|filename|base64/);
    });
});
