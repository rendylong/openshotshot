export type ManagedVideoSpec = {
    resolution: string;
    orientation: "landscape" | "portrait" | "square";
    quality: string;
    duration: { min: number; max: number; default: number; integer: boolean };
};

/** Shared IPC boundary validation. Persisted catalog entries are revalidated before use. */
export function parseManagedVideoSpecs(value: unknown): ManagedVideoSpec[] | null {
    if (!Array.isArray(value) || value.length > 32) return null;
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["resolution", "orientation", "quality", "duration"].includes(key))) return null;
        if (![entry.resolution, entry.quality].every(v => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 128)) return null;
        if (seen.has(entry.resolution) || !["landscape", "portrait", "square"].includes(entry.orientation)) return null;
        seen.add(entry.resolution);
        const d = entry.duration;
        if (!d || typeof d !== "object" || Object.keys(d).some(key => !["min", "max", "default", "integer"].includes(key))) return null;
        if (![d.min, d.max, d.default].every(v => typeof v === "number" && Number.isFinite(v) && v > 0) || typeof d.integer !== "boolean") return null;
        if (d.min > d.default || d.default > d.max || (d.integer && ![d.min, d.max, d.default].every(Number.isInteger))) return null;
    }
    return value as ManagedVideoSpec[];
}
