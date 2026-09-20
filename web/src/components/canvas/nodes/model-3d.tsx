import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Loader2, TriangleAlert, Upload, X } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { DEFAULT_MODEL_3D_CAMERA, cameraPoseFromPosition, cameraPositionForPose, model3dViewPoses, type Model3dCameraPose } from "@/lib/canvas/model-3d-camera";
import { ensureModel3dViews, getLiveSnapshot, registerCaptureFn, setLiveSnapshot, unregisterNodeSnapshots, type Model3dCapturedView } from "@/lib/canvas/model-3d-snapshot";
import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { resolveMediaUrl } from "@/services/file-storage";
import { storeCanvasModelFile } from "@/services/project-asset-storage";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";

export const MODEL_3D_NODE_TYPE = "3d";

type Model3dMeta = NonNullable<NonNullable<CanvasNodeData["metadata"]>["model3d"]>;

/** Lit three-point setup shared by the node viewport and the fullscreen preview. */
function createLitScene(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(5, 8, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-4, 2, -3);
    scene.add(rim);
    return scene;
}

/** Frame an object's bounding box in the camera view; returns the bounding radius. */
function frameModel(camera: THREE.PerspectiveCamera, controls: OrbitControls, object: THREE.Object3D, center: THREE.Vector3): number {
    const box = new THREE.Box3().setFromObject(object);
    box.getCenter(center);
    const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    const position = cameraPositionForPose(center, radius, DEFAULT_MODEL_3D_CAMERA);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
    return radius;
}

// F3: snapshots live out-of-band (module-level, see lib/canvas/model-3d-snapshot.ts) keyed by node id,
// never written into node metadata, so we never persist ~MB dataURLs into the canvas store on every frame.
// A persisted copy is uploaded once per load/generation as model3d.snapshot.storageKey so references
// survive reloads (and stay visible to collectImageStorageKeys during unused-image cleanup).
function resource(node: CanvasNodeData): CanvasNodeResource | null {
    const snapshot = getLiveSnapshot(node.id);
    return snapshot ? { kind: "image", url: snapshot } : null;
}

function Model3dContent({ ctx }: { ctx: CanvasNodeContext }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stateRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; center: THREE.Vector3; radius: number; ready: boolean } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [webglError, setWebglError] = useState("");
    const model3d = ctx.node.metadata?.model3d || {};
    const model3dRef = useRef(model3d);
    const updateMetadataRef = useRef(ctx.updateMetadata);
    model3dRef.current = model3d;
    updateMetadataRef.current = ctx.updateMetadata;
    // 项目文件资产经 hook 解析（changed/missing 事件驱动）；无 assetRef 才走旧 IndexedDB 解析器。
    const resolvedModel = useProjectAssetUrl(model3d.assetRef, "");

    const capture = useCallback(
        (requestedPrimary?: Model3dCameraPose): Model3dCapturedView[] => {
            const state = stateRef.current;
            if (!state?.renderer || !state.ready) return [];

            const savedPosition = state.camera.position.clone();
            const savedQuaternion = state.camera.quaternion.clone();
            const savedTarget = state.controls.target.clone();
            const primary = requestedPrimary || cameraPoseFromPosition(savedPosition, state.center, state.radius);
            const views: Model3dCapturedView[] = [];
            try {
                for (const view of model3dViewPoses(primary)) {
                    const position = cameraPositionForPose(state.center, state.radius, view.pose);
                    state.camera.position.set(position.x, position.y, position.z);
                    state.camera.lookAt(state.center);
                    state.camera.updateMatrixWorld();
                    state.renderer.render(state.scene, state.camera);
                    views.push({ id: view.id, dataUrl: state.renderer.domElement.toDataURL("image/png") });
                }
            } finally {
                state.camera.position.copy(savedPosition);
                state.camera.quaternion.copy(savedQuaternion);
                state.controls.target.copy(savedTarget);
                state.camera.updateMatrixWorld();
                state.controls.update();
            }
            return views;
        },
        [ctx.node.id],
    );

    useEffect(() => {
        registerCaptureFn(ctx.node.id, capture);
        return () => {
            unregisterNodeSnapshots(ctx.node.id);
        };
    }, [capture, ctx.node.id]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
        } catch (err) {
            setWebglError(err instanceof Error ? err.message : String(err));
            return;
        }
        renderer.setClearColor(0x000000, 0); // transparent: no grid/background baked into generation snapshots.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        const scene = createLitScene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
        camera.position.set(3, 2, 5);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        const center = new THREE.Vector3();
        stateRef.current = { renderer, scene, camera, controls, center, radius: 1.5, ready: false };

        const handleCameraEnd = () => {
            const state = stateRef.current;
            if (!state?.ready) return;
            const pose = cameraPoseFromPosition(state.camera.position, state.center, state.radius);
            state.renderer.render(state.scene, state.camera);
            setLiveSnapshot(ctx.node.id, state.renderer.domElement.toDataURL("image/png"));
            updateMetadataRef.current({ model3d: { ...model3dRef.current, camera: pose } });
        };
        controls.addEventListener("end", handleCameraEnd);

        const resize = () => {
            // clientWidth/clientHeight report the untransformed layout size; getBoundingClientRect() would
            // return the post-transform size (scale(k)) and drive the drawing buffer wrong. updateStyle=true
            // sets the canvas CSS size so HiDPI canvases don't render at drawing-buffer size and clip (#220).
            const width = Math.max(1, container.clientWidth);
            const height = Math.max(1, container.clientHeight);
            renderer.setSize(width, height, true);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        renderer.setAnimationLoop(() => {
            controls.update();
            renderer.render(scene, camera);
        });

        return () => {
            renderer.setAnimationLoop(null);
            observer.disconnect();
            controls.removeEventListener("end", handleCameraEnd);
            controls.dispose();
            scene.traverse((object) => {
                const mesh = object as THREE.Mesh;
                if (mesh.geometry) mesh.geometry.dispose();
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach((material) => material?.dispose?.());
            });
            renderer.dispose();
            if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
            stateRef.current = null;
        };
    }, []);

    useEffect(() => {
        const state = stateRef.current;
        if (!state) return;
        const legacySource = model3d.storageKey || model3d.content;
        if (!model3d.assetRef && !legacySource) return;
        setLoading(true);
        setError("");
        let disposed = false;
        (async () => {
            let url = "";
            if (model3d.assetRef) {
                if (resolvedModel.status === "missing") {
                    if (!disposed) {
                        setError(i18n.t("canvas.fileNode.unavailable"));
                        setLoading(false);
                    }
                    return;
                }
                if (resolvedModel.status === "ready") url = resolvedModel.url;
            } else {
                url = model3d.storageKey ? await resolveMediaUrl(model3d.storageKey, model3d.content || "") : model3d.content || "";
            }
            if (!url || disposed) return;
            try {
                const gltf = await new GLTFLoader().loadAsync(url);
                if (disposed) return;
                state.scene.add(gltf.scene);
                state.radius = frameModel(state.camera, state.controls, gltf.scene, state.center);
                const pose = model3d.camera || DEFAULT_MODEL_3D_CAMERA;
                const position = cameraPositionForPose(state.center, state.radius, pose);
                state.camera.position.set(position.x, position.y, position.z);
                state.controls.target.copy(state.center);
                state.controls.update();
                state.ready = true;
                // content carries the object URL so the host's interaction/move toggle sees a
                // truthy value (F4) — the model itself is not persisted as a dataURL in metadata.
                const nextModel3d = { ...model3d, content: url };
                ctx.updateMetadata({ content: url, model3d: nextModel3d });
                const captureNode = { ...ctx.node, metadata: { ...ctx.node.metadata, model3d: nextModel3d } };
                await ensureModel3dViews(captureNode, {
                    onPersisted: (persisted) => {
                        if (disposed) return;
                        const primary = persisted.find((view) => view.id === "primary");
                        ctx.updateMetadata({ model3d: { ...nextModel3d, camera: pose, views: persisted, ...(primary ? { snapshot: { storageKey: primary.storageKey } } : {}) } });
                    },
                });
                setLoading(false);
            } catch (err) {
                if (disposed) return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        })();
        return () => {
            disposed = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model3d.storageKey, model3d.content, model3d.assetRef, resolvedModel.url, resolvedModel.status]);

    useEffect(() => {
        const state = stateRef.current;
        if (!state?.ready || !model3d.camera) return;
        const position = cameraPositionForPose(state.center, state.radius, model3d.camera);
        state.camera.position.set(position.x, position.y, position.z);
        state.controls.target.copy(state.center);
        state.controls.update();
        state.renderer.render(state.scene, state.camera);
        setLiveSnapshot(ctx.node.id, state.renderer.domElement.toDataURL("image/png"));
    }, [ctx.node.id, model3d.camera?.azimuth, model3d.camera?.distanceRatio, model3d.camera?.elevation]);

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        setLoading(true);
        setError("");
        try {
            const uploaded = await storeCanvasModelFile(file, ctx.assetWriteContext?.({ type: "canvas-import" }));
            ctx.updateMetadata({
                content: uploaded.url,
                model3d: {
                    name: file.name,
                    content: uploaded.url,
                    mimeType: uploaded.mimeType || "model/gltf-binary",
                    bytes: uploaded.bytes,
                    ...(uploaded.storageKey ? { storageKey: uploaded.storageKey } : {}),
                    ...(uploaded.assetRef ? { assetRef: uploaded.assetRef } : {}),
                },
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
        }
    };

    const hasModel = Boolean(model3d.content || model3d.storageKey);

    return (
        <div className="relative h-full w-full overflow-hidden rounded-3xl">
            <div ref={containerRef} className="h-full w-full cursor-grab active:cursor-grabbing" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} />
            {!hasModel ? (
                <label className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-2 text-sm" style={{ color: ctx.theme.node.placeholder }}>
                    <Upload className="size-6 opacity-40" />
                    <span>{i18n.t("canvas.model3d.upload")}</span>
                    <input type="file" accept=".glb,.gltf" className="hidden" onChange={(event) => void handleFile(event.target.files?.[0])} />
                </label>
            ) : null}
            {loading ? (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs" style={{ color: ctx.theme.node.activeStroke }}>
                    <Loader2 className="size-5 animate-spin" />
                    <span>{i18n.t("canvas.model3d.loading")}</span>
                </div>
            ) : null}
            {error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <TriangleAlert className="size-5 text-red-400" />
                    <span className="text-xs leading-5 text-red-300">{error}</span>
                </div>
            ) : null}
            {webglError ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center" style={{ color: ctx.theme.node.placeholder }}>
                    <TriangleAlert className="size-5 opacity-50" />
                    <span className="text-sm">{i18n.t("canvas.model3d.webglUnavailable")}</span>
                </div>
            ) : null}
        </div>
    );
}

const definition: CanvasNodeDefinition = {
    type: MODEL_3D_NODE_TYPE,
    title: i18n.t("canvas.model3d.title"),
    icon: <Box className="size-5" />,
    defaultSize: { width: 640, height: 480 },
    defaultMetadata: { status: "success", model3d: {} },
    minimapColor: "#6366f1",
    hasSourceHandle: true,
    interactionToggle: true,
    // Static reference capability: mention eligibility and the agent referenceKind hint stay reliable
    // even before the node mounts (resource() reads the module-level snapshot cache, cold after reload).
    referenceKind: "image",
    resource,
    Content: Model3dContent,
    // Double-click is handled at the definition level (not on the content div) so it fires even when the
    // interaction/move toggle sets the content to pointer-events:none (move mode). Opens a fullscreen viewer.
    onDoubleClick: (ctx) => {
        ctx.open3dPreview();
        return true;
    },
};

/** Fullscreen viewer for browsing a 3D node's model in its own dedicated canvas (no canvas chrome). */
export function Model3dViewer({ node, onClose, onCameraChange }: { node: CanvasNodeData; onClose: () => void; onCameraChange?: (camera: Model3dCameraPose) => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const model3d = node.metadata?.model3d || {};
    const resolvedModel = useProjectAssetUrl(model3d.assetRef, "");

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
            return;
        }
        renderer.setClearColor(0x000000, 1);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        const scene = createLitScene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
        camera.position.set(3, 2, 5);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const center = new THREE.Vector3();
        let radius = 1;
        let ready = false;
        const handleCameraEnd = () => {
            if (ready) onCameraChange?.(cameraPoseFromPosition(camera.position, center, radius));
        };
        controls.addEventListener("end", handleCameraEnd);

        const resize = () => {
            const width = Math.max(1, container.clientWidth);
            const height = Math.max(1, container.clientHeight);
            renderer.setSize(width, height, true);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        renderer.setAnimationLoop(() => {
            controls.update();
            renderer.render(scene, camera);
        });

        let disposed = false;
        (async () => {
            try {
                let url = "";
                if (model3d.assetRef) {
                    if (resolvedModel.status === "missing") {
                        setError(i18n.t("canvas.fileNode.unavailable"));
                        setLoading(false);
                        return;
                    }
                    if (resolvedModel.status === "ready") url = resolvedModel.url;
                } else {
                    url = model3d.storageKey ? await resolveMediaUrl(model3d.storageKey, model3d.content || "") : model3d.content || "";
                }
                if (!url || disposed) return;
                const gltf = await new GLTFLoader().loadAsync(url);
                if (disposed) return;
                scene.add(gltf.scene);
                radius = frameModel(camera, controls, gltf.scene, center);
                const position = cameraPositionForPose(center, radius, model3d.camera || DEFAULT_MODEL_3D_CAMERA);
                camera.position.set(position.x, position.y, position.z);
                controls.target.copy(center);
                controls.update();
                ready = true;
                setLoading(false);
            } catch (err) {
                if (disposed) return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        })();

        return () => {
            disposed = true;
            renderer.setAnimationLoop(null);
            observer.disconnect();
            controls.removeEventListener("end", handleCameraEnd);
            controls.dispose();
            scene.traverse((object) => {
                const mesh = object as THREE.Mesh;
                if (mesh.geometry) mesh.geometry.dispose();
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach((material) => material?.dispose?.());
            });
            renderer.dispose();
            if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
        };
    }, [model3d.content, model3d.storageKey, model3d.assetRef, resolvedModel.url, resolvedModel.status]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[1100] flex flex-col bg-black">
            <div ref={containerRef} className="min-h-0 flex-1 cursor-grab active:cursor-grabbing" />
            <button type="button" className="absolute right-4 top-4 z-10 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20" onClick={onClose} aria-label={i18n.t("canvas.model3d.zoomBack")} title={i18n.t("canvas.model3d.zoomBack")}>
                <X className="size-5" />
            </button>
            <button type="button" className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20" onClick={onClose}>
                {i18n.t("canvas.model3d.zoomBack")}
            </button>
            {loading ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
                    <Loader2 className="size-5 animate-spin" />
                    <span>{i18n.t("canvas.model3d.loading")}</span>
                </div>
            ) : null}
            {error ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-red-300">{error}</div>
            ) : null}
        </div>
    );
}

let registered = false;
export function registerModel3dNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([definition], "builtin");
}
