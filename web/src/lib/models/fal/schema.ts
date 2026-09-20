import $RefParser from "@apidevtools/json-schema-ref-parser";
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { FalProfile, FalSchemaSelection } from "./profile-types";

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false });
addFormats(ajv);
const validators = new WeakMap<object, ValidateFunction>();
const schemaError = () => new Error("fal_schema_invalid: expected a valid, locally resolved JSON input and result schema");

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// Inspect references only; all resolution and schema semantics belong to the libraries.
function checkReferences(value: unknown, resolved: boolean, ancestors = new Set<object>()): void {
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw schemaError();
    ancestors.add(value);
    if ("$ref" in value && (resolved || typeof value.$ref !== "string" || !value.$ref.startsWith("#"))) throw schemaError();
    for (const child of Object.values(value)) checkReferences(child, resolved, ancestors);
    ancestors.delete(value);
}

function schemaAt(value: unknown): AnySchema {
    if (typeof value !== "boolean" && !record(value)) throw schemaError();
    checkReferences(value, true);
    const schema = value as AnySchema;
    // Compile synchronously with no loadSchema: unknown refs and invalid schemas fail closed.
    validatorFor(schema);
    return schema;
}

function validatorFor(schema: AnySchema): ValidateFunction {
    if (typeof schema === "boolean") return ajv.compile(schema);
    let validator = validators.get(schema);
    if (!validator) {
        if (schema.$async) throw schemaError();
        validator = ajv.compile(schema);
        validators.set(schema, validator);
    }
    return validator;
}

/** Reviewed documentation paths are separate from the authenticated SDK endpoint. */
export async function extractFalSchemas(openapi: unknown, submitPath: string, resultPath: string): Promise<FalSchemaSelection> {
    try {
        if (!record(openapi)) throw schemaError();
        checkReferences(openapi, false);
        const resolved = await $RefParser.dereference(structuredClone(openapi) as object, {
            resolve: { external: false, file: false, http: false },
            dereference: { circular: false },
        });
        const paths = record(record(resolved)?.paths);
        const submit = record(record(paths?.[submitPath])?.post);
        const result = record(record(paths?.[resultPath])?.get);
        const requestContent = record(record(submit?.requestBody)?.content);
        const responseContent = record(record(record(result?.responses)?.["200"])?.content);
        return {
            inputSchema: schemaAt(record(requestContent?.["application/json"])?.schema),
            outputSchema: schemaAt(record(responseContent?.["application/json"])?.schema),
        };
    } catch {
        // Parser/Ajv errors may contain remote URLs or schema content. Keep these private.
        throw schemaError();
    }
}

function fieldError(error: ErrorObject): string {
    const property = error.keyword === "required" ? String(error.params.missingProperty) : error.keyword === "additionalProperties" ? String(error.params.additionalProperty) : undefined;
    const suffix = property === undefined ? "" : `/${property.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    return `${error.instancePath}${suffix || (error.instancePath ? "" : "/")}: ${error.message ?? "invalid value"}`;
}

/** Pure validation: caller values, defaults and additional properties are never modified. */
export function validateFalInput(profile: FalProfile, input: unknown): void {
    let validate: ValidateFunction;
    try {
        checkReferences(profile.inputSchema, true);
        validate = validatorFor(profile.inputSchema);
    } catch {
        throw schemaError();
    }
    if (!validate(input)) {
        throw new Error(`fal_input_invalid: ${(validate.errors ?? []).map(fieldError).join("; ")}`);
    }
}
