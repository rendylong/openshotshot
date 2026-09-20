import { constants, existsSync } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
    formatSkillsForSystemPrompt,
    loadSkills as loadPiSkills,
    type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { parseSkillMarkdown } from "@/lib/skills/skill-format";
import {
    DEFAULT_SKILL_SOURCE_PREFERENCES,
    type LocalSkillDetail,
    type LocalSkillSummary,
    type SkillRuntimeRefreshResult,
    type SkillRuntimeSnapshot,
    type SkillSourceKey,
    type SkillSourcePreferences,
    type SkillSourceStatus,
} from "@/lib/skills/skill-types";

export type SkillRuntime = {
    configure(preferences: SkillSourcePreferences): Promise<SkillRuntimeSnapshot>;
    snapshot(force?: boolean): Promise<SkillRuntimeSnapshot>;
    configureResult(preferences: SkillSourcePreferences): Promise<SkillRuntimeRefreshResult>;
    snapshotResult(force?: boolean): Promise<SkillRuntimeRefreshResult>;
    agentSnapshot(): Promise<SkillRuntimeAgentSnapshot>;
    detailForUi(name: string): Promise<LocalSkillDetail | null>;
    readForUi(name: string, relativePath?: string): Promise<string>;
    readForAgent(name: string, relativePath?: string, explicitSkillName?: string): Promise<string>;
    invalidate(): void;
    systemPromptBlock(): Promise<string>;
    has(name: string): Promise<boolean>;
};

export type SkillRuntimeAgentSnapshot =
    | { ok: true; revision: number; systemPromptBlock: string; availableSkillNames: string[] }
    | { ok: false; error: string };

type SourceDefinition = {
    key: SkillSourceKey;
    paths: string[];
    readonly: boolean;
};

type SelectedSkill = {
    skill: Skill;
    source: SkillSourceKey;
    readonly: boolean;
    raw: string | null;
};

type SkillRuntimeOptions = {
    home: string;
    cwd: string;
    appSkillsRoot: string;
    loadSkills?: typeof loadPiSkills;
};

type SnapshotResolution = SkillRuntimeRefreshResult;

class SkillSourceLoadError extends Error {
    constructor(readonly sourceKey: SkillSourceKey, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "SkillSourceLoadError";
    }
}

function formatAgentSkillSummaries(skills: Skill[]): string {
    return formatSkillsForSystemPrompt(skills).replace(
        /^When a skill file references a relative path,.*absolute path in tool commands\.$/m,
        "When a skill file references a relative path, resolve it against the skill directory and read it with the read tool using the absolute path.",
    );
}

function samePreferences(left: SkillSourcePreferences, right: SkillSourcePreferences): boolean {
    return left.piGlobal === right.piGlobal
        && left.agentsGlobal === right.agentsGlobal
        && left.piProject === right.piProject
        && left.agentsProject === right.agentsProject;
}

function isEnabled(key: SkillSourceKey, preferences: SkillSourcePreferences): boolean {
    return key === "app" || preferences[key];
}

function findProjectSkillDirs(cwd: string, namespace: ".pi" | ".agents"): string[] {
    let current = resolve(cwd);
    let gitRoot: string | null = null;
    while (true) {
        if (existsSync(join(current, ".git"))) {
            gitRoot = current;
            break;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    const stop = gitRoot ?? resolve(cwd);
    const paths = new Set<string>();
    current = resolve(cwd);
    while (true) {
        paths.add(join(current, namespace, "skills"));
        if (current === stop) break;
        current = dirname(current);
    }
    return [...paths];
}

function sourceDefinitions(options: SkillRuntimeOptions): SourceDefinition[] {
    return [
        { key: "app", paths: [options.appSkillsRoot], readonly: false },
        { key: "piProject", paths: findProjectSkillDirs(options.cwd, ".pi"), readonly: true },
        { key: "agentsProject", paths: findProjectSkillDirs(options.cwd, ".agents"), readonly: true },
        { key: "piGlobal", paths: [join(options.home, ".pi", "agent", "skills")], readonly: true },
        { key: "agentsGlobal", paths: [join(options.home, ".agents", "skills")], readonly: true },
    ];
}

function formatLoadDiagnostic(source: SkillSourceKey, diagnostic: { message: string; path: string }): string {
    return `[${source}] ${diagnostic.message}: ${diagnostic.path}`;
}

function isInside(root: string, target: string): boolean {
    return target === root || target.startsWith(root + sep);
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
    let current = root;
    if ((await lstat(current)).isSymbolicLink()) throw new Error("不允许读取 Skill 符号链接");
    const relativePath = relative(root, target);
    for (const part of relativePath.split(sep).filter(Boolean)) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new Error("不允许读取 Skill 符号链接");
    }
}

type PathIdentity = { path: string; dev: bigint; ino: bigint };

function sameIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

async function captureAncestorIdentities(root: string, target: string): Promise<{ canonicalRoot: string; ancestors: PathIdentity[] }> {
    const ancestors: PathIdentity[] = [];
    let current = root;
    const parts = relative(root, target).split(sep).filter(Boolean);
    for (const part of ["", ...parts.slice(0, -1)]) {
        if (part) current = join(current, part);
        const info = await lstat(current, { bigint: true });
        if (info.isSymbolicLink()) throw new Error("不允许读取 Skill 符号链接");
        if (!info.isDirectory()) throw new Error("Skill 路径不是目录");
        ancestors.push({ path: current, dev: info.dev, ino: info.ino });
    }
    return { canonicalRoot: await realpath(root), ancestors };
}

async function verifyOpenedPath(
    target: string,
    expected: { canonicalRoot: string; ancestors: PathIdentity[] },
    opened: { dev: bigint; ino: bigint },
): Promise<void> {
    for (const identity of expected.ancestors) {
        const current = await lstat(identity.path, { bigint: true });
        if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identity, current)) {
            throw new Error("Skill 路径在读取期间发生变化");
        }
    }
    if (await realpath(expected.ancestors[0]!.path) !== expected.canonicalRoot) {
        throw new Error("Skill 路径在读取期间发生变化");
    }
    const canonicalTarget = await realpath(target);
    if (!isInside(expected.canonicalRoot, canonicalTarget)) throw new Error("Skill 路径越界");
    const currentTarget = await stat(canonicalTarget, { bigint: true });
    if (!currentTarget.isFile() || !sameIdentity(opened, currentTarget)) {
        throw new Error("Skill 文件在读取期间发生变化");
    }
}

async function safeRead(selected: SelectedSkill, relativePath?: string): Promise<string> {
    const root = resolve(dirname(selected.skill.filePath));
    const target = relativePath === undefined ? resolve(selected.skill.filePath) : resolve(root, relativePath);
    if (!isInside(root, target)) throw new Error("Skill 路径越界");
    if (typeof constants.O_NOFOLLOW !== "number") throw new Error("当前平台无法安全读取 Skill 文件");
    const expected = await captureAncestorIdentities(root, target);
    let handle: FileHandle;
    try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("不允许读取 Skill 符号链接");
        throw error;
    }
    try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile()) throw new Error("只允许读取 Skill 目录内的普通文件");
        await verifyOpenedPath(target, expected, opened);
        const content = await handle.readFile();
        await verifyOpenedPath(target, expected, opened);
        return content.toString("utf8");
    } finally {
        await handle.close();
    }
}

async function collectFiles(root: string): Promise<string[]> {
    await assertNoSymlink(root, root);
    const canonicalRoot = await realpath(root);
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile()) files.push(relative(canonicalRoot, path));
        }
    };
    await visit(canonicalRoot);
    return files.sort();
}

function displayMetadata(raw: string): Pick<LocalSkillDetail, "displayName" | "shortDescription"> {
    const parsed = parseSkillMarkdown(raw);
    return parsed.ok
        ? { displayName: parsed.skill.displayName, shortDescription: parsed.skill.shortDescription }
        : {};
}

async function optionalSkillFile(selected: SelectedSkill): Promise<string | null> {
    try { return await safeRead(selected); } catch { return null; }
}

export function createSkillRuntime(options: SkillRuntimeOptions): SkillRuntime {
    const env = new NodeExecutionEnv({ cwd: options.cwd });
    const loadSkills = options.loadSkills ?? loadPiSkills;
    let preferences = { ...DEFAULT_SKILL_SOURCE_PREFERENCES };
    let revision = 0;
    let dirty = true;
    let cached: SkillRuntimeSnapshot | null = null;
    let selectedSkills = new Map<string, SelectedSkill>();

    const buildSnapshot = async (
        refreshPreferences: SkillSourcePreferences,
        refreshRevision: number,
    ): Promise<{ snapshot: SkillRuntimeSnapshot; selected: Map<string, SelectedSkill> }> => {
        const selected = new Map<string, SelectedSkill>();
        const diagnostics: string[] = [];
        const sources: SkillSourceStatus[] = [];

        for (const source of sourceDefinitions(options)) {
            const enabled = isEnabled(source.key, refreshPreferences);
            const sourceDiagnostics: string[] = [];
            const sourceErrors: string[] = [];
            let skillCount = 0;
            if (enabled && source.paths.length > 0) {
                const loaded = await loadSkills(env, source.paths).catch((error) => {
                    throw new SkillSourceLoadError(source.key, error);
                });
                for (const diagnostic of loaded.diagnostics) {
                    const message = formatLoadDiagnostic(source.key, diagnostic);
                    diagnostics.push(message);
                    sourceDiagnostics.push(message);
                    if (["file_info_failed", "list_failed", "read_failed"].includes(diagnostic.code)) {
                        sourceErrors.push(`${diagnostic.message}: ${diagnostic.path}`);
                    }
                }
                const invalidPaths = new Set(loaded.diagnostics
                    .filter((diagnostic) => diagnostic.code === "invalid_metadata")
                    .map((diagnostic) => diagnostic.path));
                const availableSkills = loaded.skills.filter((skill) => !invalidPaths.has(skill.filePath));
                skillCount = availableSkills.length;
                for (const skill of availableSkills) {
                    const existing = selected.get(skill.name);
                    if (existing) {
                        const message = `Skill "${skill.name}" 冲突：保留 ${existing.skill.filePath}，忽略 ${skill.filePath}`;
                        diagnostics.push(message);
                        sourceDiagnostics.push(message);
                        continue;
                    }
                    selected.set(skill.name, { skill, source: source.key, readonly: source.readonly, raw: null });
                }
            }
            sources.push({
                key: source.key,
                enabled,
                readonly: source.readonly,
                paths: source.paths,
                exists: source.paths.some((path) => existsSync(path)),
                skillCount,
                diagnostics: sourceDiagnostics,
                error: sourceErrors.length ? sourceErrors.join("\n") : null,
            });
        }

        const skills: LocalSkillSummary[] = [];
        for (const selectedSkill of selected.values()) {
            const { skill, source, readonly } = selectedSkill;
            selectedSkill.raw = await optionalSkillFile(selectedSkill);
            const metadata = selectedSkill.raw ? displayMetadata(selectedSkill.raw) : {};
            skills.push({
                name: skill.name,
                description: skill.description,
                ...metadata,
                path: dirname(skill.filePath),
                source,
                manualOnly: skill.disableModelInvocation === true,
                readonly,
                valid: true,
                error: null,
            });
        }
        return { snapshot: { revision: refreshRevision, skills, sources, diagnostics }, selected };
    };

    const resolveSnapshot = async (force = false): Promise<SnapshotResolution> => {
        if (!dirty && !force && cached) return { fresh: true, snapshot: cached };
        const refreshPreferences = { ...preferences };
        const refreshRevision = revision;
        try {
            const next = await buildSnapshot(refreshPreferences, refreshRevision);
            if (refreshRevision !== revision) return resolveSnapshot();
            cached = next.snapshot;
            selectedSkills = next.selected;
            dirty = false;
            return { fresh: true, snapshot: cached };
        } catch (error) {
            if (refreshRevision !== revision) return resolveSnapshot();
            const sourceFailure = error instanceof SkillSourceLoadError ? error : null;
            const detail = error instanceof Error ? error.message : String(error);
            const message = `Skill 刷新失败：${sourceFailure ? `[${sourceFailure.sourceKey}] ` : ""}${detail}`;
            const sourcesWithFailure = (sources: SkillSourceStatus[]): SkillSourceStatus[] => sources.map((source) => ({
                ...source,
                enabled: isEnabled(source.key, refreshPreferences),
                error: source.key === sourceFailure?.sourceKey ? detail : null,
            }));
            const fallback: SkillRuntimeSnapshot = cached
                ? { ...cached, revision: refreshRevision, sources: sourcesWithFailure(cached.sources), diagnostics: [...cached.diagnostics, message] }
                : {
                    revision: refreshRevision,
                    skills: [],
                    sources: sourcesWithFailure(sourceDefinitions(options).map((source) => ({
                        ...source,
                        enabled: isEnabled(source.key, refreshPreferences),
                        exists: source.paths.some((path) => existsSync(path)),
                        skillCount: 0,
                        diagnostics: [],
                        error: null,
                    }))),
                    diagnostics: [message],
                };
            return { fresh: false, snapshot: fallback, error: message };
        }
    };

    const configureResult = async (nextPreferences: SkillSourcePreferences): Promise<SkillRuntimeRefreshResult> => {
        if (!samePreferences(preferences, nextPreferences)) {
            preferences = { ...nextPreferences };
            revision += 1;
            dirty = true;
        }
        return resolveSnapshot();
    };

    const snapshotResult = (force = false): Promise<SkillRuntimeRefreshResult> => resolveSnapshot(force);
    const snapshot = async (force = false): Promise<SkillRuntimeSnapshot> => (await snapshotResult(force)).snapshot;
    const configure = async (nextPreferences: SkillSourcePreferences): Promise<SkillRuntimeSnapshot> => (await configureResult(nextPreferences)).snapshot;

    const isAuthorized = (selected: SelectedSkill): boolean => isEnabled(selected.source, preferences);

    const authorizedSelection = (name: string): SelectedSkill | undefined => {
        const selected = selectedSkills.get(name);
        return selected && isAuthorized(selected) ? selected : undefined;
    };

    const lookupForUi = async (name: string): Promise<{ selected: SelectedSkill; fresh: boolean } | undefined> => {
        const resolved = await resolveSnapshot();
        const selected = authorizedSelection(name);
        return selected ? { selected, fresh: resolved.fresh } : undefined;
    };

    const lookupForAgent = async (name: string): Promise<SelectedSkill | undefined> => {
        const resolved = await resolveSnapshot();
        return resolved.fresh ? authorizedSelection(name) : undefined;
    };

    return {
        configure,
        snapshot,
        configureResult,
        snapshotResult,
        async agentSnapshot() {
            const resolved = await resolveSnapshot();
            if (!resolved.fresh) return { ok: false, error: resolved.error };
            const available = [...selectedSkills.values()].filter(isAuthorized);
            return {
                ok: true,
                revision: resolved.snapshot.revision,
                systemPromptBlock: formatAgentSkillSummaries(available.map(({ skill }) => skill)),
                availableSkillNames: available.map(({ skill }) => skill.name),
            };
        },
        async detailForUi(name) {
            const found = await lookupForUi(name);
            if (!found) return null;
            const { selected } = found;
            const root = dirname(selected.skill.filePath);
            let raw: string;
            let files: string[];
            try {
                raw = await safeRead(selected);
                files = await collectFiles(root);
            } catch (error) {
                if (found.fresh || !selected.raw) throw error;
                raw = selected.raw;
                files = ["SKILL.md"];
            }
            return {
                name: selected.skill.name,
                description: selected.skill.description,
                instructions: selected.skill.content,
                ...displayMetadata(raw),
                path: root,
                files,
            };
        },
        async readForUi(name, relativePath) {
            const found = await lookupForUi(name);
            if (!found) throw new Error(`找不到可用 Skill：${name}`);
            try {
                return await safeRead(found.selected, relativePath);
            } catch (error) {
                if (found.fresh || (relativePath !== undefined && relativePath !== "SKILL.md") || !found.selected.raw) throw error;
                return found.selected.raw;
            }
        },
        async readForAgent(name, relativePath, explicitSkillName) {
            const selected = await lookupForAgent(name);
            if (!selected) throw new Error(`找不到可用 Skill：${name}`);
            if (selected.skill.disableModelInvocation === true && explicitSkillName !== name) {
                throw new Error(`仅允许在当前请求显式调用 /${name} 后读取此 Skill`);
            }
            return safeRead(selected, relativePath);
        },
        invalidate() {
            revision += 1;
            dirty = true;
        },
        async systemPromptBlock() {
            const resolved = await resolveSnapshot();
            if (!resolved.fresh) return "";
            return formatAgentSkillSummaries([...selectedSkills.values()]
                .filter(isAuthorized)
                .map(({ skill }) => skill));
        },
        async has(name) {
            return Boolean(await lookupForAgent(name));
        },
    };
}
