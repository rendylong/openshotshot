// Category model for Project. A project's category is a free-form string
// normalized to a lowercase key; display formatting is the caller's concern.
export const UNCATEGORIZED = "uncategorized";

// Reserved project id that acts as an invisible container for canvases
// created without an explicit project (e.g. home page composer submissions).
export const UNCATEGORIZED_PROJECT_ID = "__uncategorized__";

// Normalize any persisted/raw category value to a canonical key:
// undefined/null/empty -> "uncategorized", otherwise trim + lowercase.
export function canonicalCategory(raw: unknown): string {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    return value || UNCATEGORIZED;
}

export function filterProjectsByCategory<T extends { category?: unknown }>(projects: T[], category: string): T[] {
    const target = canonicalCategory(category);
    return projects.filter((project) => canonicalCategory(project.category) === target);
}

// Sorted, de-duplicated list of categories present across projects, always
// including "uncategorized" so the move-to-category menu has a stable fallback.
export function projectCategories<T extends { category?: unknown }>(projects: T[]): string[] {
    const categories = new Set<string>([UNCATEGORIZED]);
    projects.forEach((project) => categories.add(canonicalCategory(project.category)));
    return [...categories].sort();
}
