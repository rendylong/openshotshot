import { expectTypeOf, it } from "vitest";
import type { FalField, FalProfile } from "./profile-types";

it("describes scalar array controls without accepting nested object arrays", () => {
    const field = { name: "tags", labelKey: "fal.tags", kind: "array", items: { kind: "string", options: ["product"] } } satisfies FalField;
    type ArrayField = Extract<FalField, { kind: "array" }>;
    expectTypeOf<ArrayField["items"]["kind"]>().toEqualTypeOf<"string" | "number" | "boolean">();
    expectTypeOf<NonNullable<ArrayField["items"]["options"]>[number]>().toEqualTypeOf<string | number | boolean>();
    expectTypeOf<FalProfile["version"]>().toEqualTypeOf<1>();
    expectTypeOf(field.kind).toEqualTypeOf<"array">();
});
