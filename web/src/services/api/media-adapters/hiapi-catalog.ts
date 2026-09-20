import axios from "axios";
import localforage from "localforage";

const HIAPI_CATALOG_URL = "https://www.hiapi.ai/docs/models.json";
const HIAPI_CATALOG_STORAGE_KEY = "shotshot:hiapi_catalog_v1";

export type HiapiCatalogCategory = "image" | "video" | "audio" | "text";

export type HiapiInputField = {
    name: string;
    type: string;
    required: boolean;
    enum?: readonly string[];
    default?: unknown;
};

export type HiapiModelEntry = {
    id: string;
    title: string;
    category: HiapiCatalogCategory;
    capability: string;
    input: readonly HiapiInputField[];
};

type HiapiCatalogPayload = {
    fetchedAt: number;
    etag: string | null;
    models: HiapiModelEntry[];
};

let mirror: HiapiCatalogPayload | null = null;
let inflight: Promise<HiapiCatalogPayload | null> | null = null;

function normalizeModelId(id: string): string {
    return id.trim().toLowerCase();
}

function readPayload(raw: unknown): HiapiCatalogPayload | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const root = raw as { fetchedAt?: unknown; etag?: unknown; models?: unknown };
    if (!Array.isArray(root.models)) return null;
    return {
        fetchedAt: typeof root.fetchedAt === "number" ? root.fetchedAt : 0,
        etag: typeof root.etag === "string" ? root.etag : null,
        models: root.models.filter((entry): entry is HiapiModelEntry => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
            const candidate = entry as { id?: unknown; category?: unknown; input?: unknown };
            return typeof candidate.id === "string" && typeof candidate.category === "string" && Array.isArray(candidate.input);
        }),
    };
}

async function readPersistedCatalog(): Promise<HiapiCatalogPayload | null> {
    if (typeof window === "undefined") return null;
    try {
        const raw = await localforage.getItem<unknown>(HIAPI_CATALOG_STORAGE_KEY);
        return readPayload(raw);
    } catch {
        try {
            const raw = window.localStorage.getItem(HIAPI_CATALOG_STORAGE_KEY);
            return raw ? readPayload(JSON.parse(raw)) : null;
        } catch {
            return null;
        }
    }
}

async function writePersistedCatalog(payload: HiapiCatalogPayload): Promise<void> {
    if (typeof window === "undefined") return;
    try {
        await localforage.setItem(HIAPI_CATALOG_STORAGE_KEY, payload as unknown as object);
    } catch {
        try {
            window.localStorage.setItem(HIAPI_CATALOG_STORAGE_KEY, JSON.stringify(payload));
        } catch {
            // ignore quota or serialization errors
        }
    }
}

function normalizeCatalogResponse(raw: unknown, etag: string | null): HiapiCatalogPayload | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const models = (raw as { models?: unknown }).models;
    if (!Array.isArray(models)) return null;
    const entries: HiapiModelEntry[] = [];
    for (const candidate of models) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const entry = candidate as { id?: unknown; title?: unknown; category?: unknown; capability?: unknown; input?: unknown };
        if (typeof entry.id !== "string" || typeof entry.category !== "string" || !Array.isArray(entry.input)) continue;
        const input: HiapiInputField[] = [];
        for (const field of entry.input) {
            if (!field || typeof field !== "object" || Array.isArray(field)) continue;
            const f = field as { name?: unknown; type?: unknown; required?: unknown; enum?: unknown; default?: unknown };
            if (typeof f.name !== "string" || typeof f.type !== "string") continue;
            input.push({
                name: f.name,
                type: f.type,
                required: f.required === true,
                ...(Array.isArray(f.enum) ? { enum: f.enum.filter((v): v is string => typeof v === "string") } : {}),
                ...(f.default !== undefined ? { default: f.default } : {}),
            });
        }
        entries.push({
            id: entry.id,
            title: typeof entry.title === "string" ? entry.title : entry.id,
            category: entry.category as HiapiCatalogCategory,
            capability: typeof entry.capability === "string" ? entry.capability : "",
            input,
        });
    }
    return { fetchedAt: Date.now(), etag, models: entries };
}

export async function fetchHiapiCatalog(options: { force?: boolean } = {}): Promise<HiapiCatalogPayload | null> {
    if (inflight) return inflight;
    if (!options.force && mirror) return mirror;
    inflight = (async () => {
        if (!options.force && !mirror) {
            const persisted = await readPersistedCatalog();
            if (persisted) mirror = persisted;
        }
        try {
            const response = await axios.get<unknown>(HIAPI_CATALOG_URL, { responseType: "json" });
            const payload = normalizeCatalogResponse(response.data, null);
            if (payload) {
                mirror = payload;
                await writePersistedCatalog(payload);
            }
            return payload;
        } catch {
            return mirror;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

export function getHiapiCatalogMirror(): HiapiCatalogPayload | null {
    return mirror;
}

export function lookupHiapiModel(modelId: string): HiapiModelEntry | null {
    if (!mirror) return null;
    const target = normalizeModelId(modelId);
    return mirror.models.find((entry) => normalizeModelId(entry.id) === target) ?? null;
}

export type HiapiImageFieldPlan = { kind: "single"; field: string } | { kind: "array"; field: string } | { kind: "media" };

const IMAGE_FIELD_CANDIDATES_SINGLE = ["first_frame_url", "last_frame_url", "image", "image_url", "input_url"];
const IMAGE_FIELD_CANDIDATES_ARRAY = ["reference_image_urls", "image_urls", "input_urls"];

export function detectHiapiImageField(modelId: string): HiapiImageFieldPlan | null {
    const entry = lookupHiapiModel(modelId);
    if (!entry) return null;
    const inputNames = new Set(entry.input.map((field) => field.name));
    for (const candidate of IMAGE_FIELD_CANDIDATES_SINGLE) {
        if (inputNames.has(candidate)) {
            const field = entry.input.find((f) => f.name === candidate);
            if (field && field.type !== "string[]") return { kind: "single", field: candidate };
        }
    }
    if (inputNames.has("media")) {
        const field = entry.input.find((f) => f.name === "media");
        if (field && (field.type === "object[]" || field.type === "array")) return { kind: "media" };
    }
    for (const candidate of IMAGE_FIELD_CANDIDATES_ARRAY) {
        if (inputNames.has(candidate)) return { kind: "array", field: candidate };
    }
    return null;
}

function parseNumericPortion(value: string): number | undefined {
    const lower = value.toLowerCase().trim();
    if (!lower) return undefined;
    if (lower.endsWith("k")) {
        const n = Number(lower.slice(0, -1));
        return Number.isFinite(n) ? n * 1024 : undefined;
    }
    if (lower.endsWith("p")) {
        const n = Number(lower.slice(0, -1));
        return Number.isFinite(n) ? n : undefined;
    }
    const n = Number(lower);
    return Number.isFinite(n) ? n : undefined;
}

function pickEnumValue(enumValues: readonly string[], userValue: unknown): string {
    if (typeof userValue === "number" || typeof userValue === "string") {
        const userStr = String(userValue).toLowerCase().trim();
        if (userStr) {
            for (const e of enumValues) {
                if (e.toLowerCase() === userStr) return e;
            }
            const userNum = parseNumericPortion(userStr);
            if (userNum !== undefined) {
                for (const e of enumValues) {
                    const eNum = parseNumericPortion(e);
                    if (eNum === userNum) return e;
                }
            }
        }
    }
    return enumValues[0]!;
}

/** Resolve a payload value against the model's documented schema for a given input field. */
export function resolveCatalogFieldValue(modelId: string, fieldName: string, userValue: unknown): unknown {
    const entry = lookupHiapiModel(modelId);
    if (!entry) return userValue;
    const field = entry.input.find((f) => f.name === fieldName);
    if (!field) return userValue;
    if (Array.isArray(field.enum) && field.enum.length > 0) {
        if (userValue === undefined || userValue === null || userValue === "") {
            return field.default ?? field.enum[0];
        }
        return pickEnumValue(field.enum, userValue);
    }
    if (userValue === undefined || userValue === null) {
        return field.default;
    }
    return userValue;
}
