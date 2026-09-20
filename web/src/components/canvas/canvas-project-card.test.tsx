import { render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, test, vi } from "vitest";

const resolveCanvasAssetUrl = vi.hoisted(() =>
    vi.fn(async (assetRef?: { backend?: string }, fallback?: string) => {
        if (!assetRef) return fallback ?? "";
        return assetRef.backend === "indexeddb" ? "blob:from-idb" : "blob:from-ref";
    }),
);
vi.mock("@/services/project-asset-storage", () => ({ resolveCanvasAssetUrl }));

import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { Project } from "@/stores/canvas/use-project-store";
import i18n from "@/i18n";

const project = {
    id: "project-1",
    title: "Project One",
    category: "uncategorized",
    icon: "folder",
    color: "#6366f1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    canvases: [],
};

const imageNode = (id: string, content?: string) => ({
    id,
    type: "image",
    title: `Image ${id}`,
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: content ? { content, status: "success" as const } : { status: "idle" as const },
});

describe("CanvasProjectCard", () => {
    test("uses the whole card as the only action without selection or utility controls", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter>
                    <CanvasProjectCard project={project} />
                </MemoryRouter>
            </I18nextProvider>,
        );

        expect(screen.getByRole("button", { name: /Project One/ })).toBeInTheDocument();
        expect(screen.getAllByRole("button")).toHaveLength(1);
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    });

    test("renders two paper previews when the project has no image artifacts", () => {
        const { container } = render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter>
                    <CanvasProjectCard project={project} />
                </MemoryRouter>
            </I18nextProvider>,
        );

        expect(container.querySelectorAll(".canvas-project-card__artifact--placeholder")).toHaveLength(2);
    });

    test("shows only the latest two usable image artifacts from the newest canvases", () => {
        const { container } = render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter>
                    <CanvasProjectCard
                        project={{
                            ...project,
                            canvases: [
                                {
                                    id: "older",
                                    title: "Older",
                                    createdAt: "2026-08-30T00:00:00.000Z",
                                    updatedAt: "2026-08-30T00:00:00.000Z",
                                    nodes: [imageNode("old", "data:image/png;base64,old")],
                                    connections: [],
                                    chatSessions: [],
                                    activeChatId: null,
                                    backgroundMode: "lines",
                                    showImageInfo: false,
                                    viewport: { x: 0, y: 0, k: 1 },
                                },
                                {
                                    id: "newer",
                                    title: "Newer",
                                    createdAt: "2026-08-31T00:00:00.000Z",
                                    updatedAt: "2026-08-31T00:00:00.000Z",
                                    nodes: [imageNode("first", "data:image/png;base64,first"), imageNode("empty"), imageNode("latest", "data:image/png;base64,latest")],
                                    connections: [],
                                    chatSessions: [],
                                    activeChatId: null,
                                    backgroundMode: "lines",
                                    showImageInfo: false,
                                    viewport: { x: 0, y: 0, k: 1 },
                                },
                            ],
                        }}
                    />
                </MemoryRouter>
            </I18nextProvider>,
        );

        expect([...container.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["data:image/png;base64,first", "data:image/png;base64,latest"]);
    });
});

const T = "2026-09-01T00:00:00.000Z";
const pfileRef = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/generated/images/a1.png" };

function projectWithMetadata(metadata: Record<string, unknown>): Project {
    return {
        id: "p1", title: "P", category: "uncategorized", icon: "box", color: "#000", createdAt: T, updatedAt: T,
        canvases: [{ id: "c1", title: "C", createdAt: T, updatedAt: T, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, nodes: [{ id: "n1", type: "image", title: "n", position: { x: 0, y: 0 }, width: 10, height: 10, metadata }] }],
    } as unknown as Project;
}

describe("CanvasProjectCard 缩略图", () => {
    it("assetRef-only 节点（重载后 content 为死 objectURL）经 resolveCanvasAssetUrl 解析", async () => {
        render(<MemoryRouter><CanvasProjectCard project={projectWithMetadata({ assetRef: pfileRef, content: "blob:dead-object-url", status: "success" })} /></MemoryRouter>);
        await waitFor(() => expect(resolveCanvasAssetUrl).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByRole("button").querySelector("img")?.getAttribute("src")).toBe("blob:from-ref"));
    });

    it("storageKey-only 节点（迁移前存量：无 assetRef）兜底合成 indexeddb ref 走 IDB 解析", async () => {
        render(<MemoryRouter><CanvasProjectCard project={projectWithMetadata({ storageKey: "image:legacy-key", content: "blob:dead-object-url", status: "success" })} /></MemoryRouter>);
        await waitFor(() =>
            expect(resolveCanvasAssetUrl).toHaveBeenCalledWith(expect.objectContaining({ backend: "indexeddb", storageKey: "image:legacy-key" }), "blob:dead-object-url"),
        );
        await waitFor(() => expect(screen.getByRole("button").querySelector("img")?.getAttribute("src")).toBe("blob:from-idb"));
    });
});
