import type { AnySchema } from "ajv";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type FalScalarKind = "string" | "number" | "boolean" | "enum";
type FalFieldBase = {
    name: string;
    labelKey: string;
    common?: "size" | "quality" | "seconds" | "resolution" | "generateAudio";
    advanced?: boolean;
    valueMap?: Readonly<Record<string, JsonValue>>;
    secondsFormat?: "number" | "string" | "seconds-suffix";
};
export type FalField = FalFieldBase & ({ kind: FalScalarKind; options?: JsonValue[] } | { kind: "array"; items: { kind: "string" | "number" | "boolean"; options?: (string | number | boolean)[] } });
export type FalMediaConstraints = {
    maxBytes?: number;
    mimeTypes?: readonly string[];
    minDimension?: number;
    maxDimension?: number;
    minAspectRatio?: number;
    maxAspectRatio?: number;
};
export type FalMediaSlot = {
    constraints?: FalMediaConstraints;
    field: string;
    mode: "one" | "many";
    role: "references" | "first" | "last";
    required: boolean;
};
export type FalProfile = {
    id: string;
    version: 1;
    endpointId: string;
    modality: "image" | "video";
    submitPath?: string;
    resultPath?: string;
    inputSchema: AnySchema;
    outputSchema: AnySchema;
    defaults: Record<string, JsonValue>;
    fields: readonly FalField[];
    media: readonly FalMediaSlot[];
};
export type FalSchemaSelection = { inputSchema: AnySchema; outputSchema: AnySchema };

/** Authored per-endpoint admission decisions; never inferred from endpoint families. */
export type FalProfileDescriptor = {
    endpointId: string;
    submitPath: string;
    resultPath: string;
    defaults: Record<string, JsonValue>;
    fields: readonly { name: string; common?: FalField["common"]; valueMap?: FalField["valueMap"]; secondsFormat?: FalField["secondsFormat"] }[];
    media: readonly FalMediaSlot[];
    inputConstraints?: Record<string, unknown>;
    propertyConstraints?: Record<string, Record<string, unknown>>;
};
