import { describe, expect, test } from "vitest";

import { isRemoteResultRetry, remoteTaskErrorText, remoteTaskForNode, selectNodeRemoteTaskDisplay } from "./remote-media-task-ui";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage, type CanvasRemoteTaskMetadata } from "@/types/canvas";

const task = (status: CanvasRemoteTaskMetadata["status"] = "pending"): CanvasRemoteTaskMetadata => ({ id: "task-1", status, submittedAt: 1 });
const node = (images: CanvasNodeImage[]): CanvasNodeData => ({ id: "node-1", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", images } });
const image = (patch: Partial<CanvasNodeImage>): CanvasNodeImage => ({ id: "item-1", status: "loading", content: "", naturalWidth: 1, naturalHeight: 1, bytes: 0, mimeType: "image/png", ...patch });

describe("remote media task UI state", () => {
    test("reads a single image task from durable item metadata", () => {
        expect(remoteTaskForNode(node([image({ remoteTask: task() })]))).toEqual(task());
    });

    test("keeps concrete provider or persistence errors ahead of a generic terminal label", () => {
        expect(remoteTaskErrorText(task("failed"), "provider quota exceeded", (key) => key)).toBe("provider quota exceeded");
        expect(remoteTaskErrorText(task("failed"), "indexeddb unavailable", (key) => key)).toBe("indexeddb unavailable");
    });

    test("maps known gateway error codes to friendly copy and passes unknown codes through", () => {
        const translate = (key: string) => key;
        expect(remoteTaskErrorText(task("failed"), "upstream_failed", translate)).toBe("canvas.remoteTask.errorUpstreamFailed");
        expect(remoteTaskErrorText(task("failed"), "rejected_before_submit", translate)).toBe("canvas.remoteTask.errorRejectedBeforeSubmit");
        expect(remoteTaskErrorText(task("failed"), "delivery_failed", translate)).toBe("canvas.remoteTask.errorDeliveryFailed");
        expect(remoteTaskErrorText(task("failed"), "some_new_code", translate)).toBe("some_new_code");
    });

    test("uses the actual single-item selector and batch error formatter for concrete failures", () => {
        const single = node([image({ status: "error", errorDetails: "provider quota exceeded", remoteTask: task("failed") })]);
        single.metadata!.status = "error";
        single.metadata!.errorDetails = "failed";

        expect(selectNodeRemoteTaskDisplay(single)).toEqual({ task: task("failed"), errorDetails: "provider quota exceeded" });
        expect(remoteTaskErrorText(single.metadata?.images?.[0].remoteTask, single.metadata?.images?.[0].errorDetails, (key) => key)).toBe("provider quota exceeded");
    });
    test("labels failed video task retries as result queries", () => {
        const video = { ...node([]), type: CanvasNodeType.Video, metadata: { remoteTask: task("timed_out") } };
        expect(isRemoteResultRetry(video, [])).toBe(true);
        expect(isRemoteResultRetry({ ...video, metadata: { remoteTask: task("submission_unknown") } }, [])).toBe(true);
        expect(isRemoteResultRetry(node([]), [])).toBe(false);
    });

});

test("fal image recovery uses the durable exact item identity even after model edits", () => {
    const imageNode = node([image({ remoteTask: task("failed") })]);
    imageNode.metadata!.model = "other::edited-model";
    const saved = { id: "task-1", capability: "image", adapterId: "fal.image", target: { nodeId: "node-1", itemId: "item-1" } } as never;
    expect(isRemoteResultRetry(imageNode, [saved])).toBe(true);
    expect(isRemoteResultRetry(imageNode, [saved], "other-item")).toBe(false);
    expect(isRemoteResultRetry(imageNode, [{ ...saved as object, adapterId: "other.image" } as never])).toBe(false);
    expect(isRemoteResultRetry(imageNode, [])).toBe(true);
    imageNode.metadata!.images!.push(image({ id: "item-2" }));
    expect(isRemoteResultRetry(imageNode, [saved])).toBe(true);
});

test("shotshot managed image failures are labeled as original-task result recovery", () => {
    const imageNode = node([image({ remoteTask: task("failed") })]);
    const saved = { id: "task-1", remoteTaskId: "remote-managed-1", capability: "image", adapterId: "shotshot.managed-image", target: { nodeId: "node-1", itemId: "item-1" } } as never;

    expect(isRemoteResultRetry(imageNode, [saved])).toBe(true);
});
