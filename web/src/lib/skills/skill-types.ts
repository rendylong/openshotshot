export type SkillSourceKey = "app" | "piGlobal" | "agentsGlobal" | "piProject" | "agentsProject";
export type OptionalSkillSourceKey = Exclude<SkillSourceKey, "app">;
export type SkillSourcePreferences = Record<OptionalSkillSourceKey, boolean>;

export const DEFAULT_SKILL_SOURCE_PREFERENCES: SkillSourcePreferences = {
    piGlobal: false,
    agentsGlobal: false,
    piProject: false,
    agentsProject: false,
};

export type SkillSourceStatus = {
    key: SkillSourceKey;
    enabled: boolean;
    readonly: boolean;
    paths: string[];
    exists: boolean;
    skillCount: number;
    diagnostics: string[];
    error?: string | null;
};

export type LocalSkillSummary = {
    name: string;
    description: string;
    displayName?: string | null;
    shortDescription?: string | null;
    path: string;
    source: SkillSourceKey;
    manualOnly: boolean;
    readonly: boolean;
    valid: boolean;
    error?: string | null;
};

export type LocalSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    files: string[];
    displayName?: string | null;
    shortDescription?: string | null;
    path: string;
};

export type SkillRuntimeSnapshot = {
    revision: number;
    skills: LocalSkillSummary[];
    sources: SkillSourceStatus[];
    diagnostics: string[];
};

export type SkillRuntimeRefreshResult =
    | { fresh: true; snapshot: SkillRuntimeSnapshot }
    | { fresh: false; snapshot: SkillRuntimeSnapshot; error: string };

export type SkillWriteInput = {
    description: string;
    instructions: string;
    displayName?: string | null;
    shortDescription?: string | null;
};

export type SkillsBridge = {
    configure(preferences: SkillSourcePreferences): Promise<SkillRuntimeRefreshResult>;
    scan(force?: boolean): Promise<SkillRuntimeRefreshResult>;
    read(name: string): Promise<LocalSkillDetail | null>;
    readFile(name: string, relativePath?: string): Promise<{ ok: true; content: string } | { ok: false; error: string }>;
    write(name: string, input: SkillWriteInput): Promise<{ ok: boolean; error?: string }>;
    importSkill(sourcePath: string): Promise<{ name: string; error?: string } | null>;
    remove(name: string): Promise<{ ok: boolean }>;
    seed(): Promise<{ ok: boolean; error?: string }>;
    pickFolder(): Promise<string | null>;
};
