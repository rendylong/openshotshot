import { describe, expect, test } from "vitest";

import {
    DEFAULT_MODEL_3D_CAMERA,
    MODEL_3D_CAMERA_PRESETS,
    cameraPoseFromPosition,
    cameraPositionForPose,
    model3dViewPoses,
} from "@/lib/canvas/model-3d-camera";

describe("model 3D camera coordinates", () => {
    test("maps front, right, and left poses to model-relative world positions", () => {
        const center = { x: 1, y: 2, z: 3 };
        expect(cameraPositionForPose(center, 2, { azimuth: 0, elevation: 0, distanceRatio: 2 })).toEqual({ x: 1, y: 2, z: 7 });
        expect(cameraPositionForPose(center, 2, { azimuth: 90, elevation: 0, distanceRatio: 2 }).x).toBeCloseTo(5, 8);
        expect(cameraPositionForPose(center, 2, { azimuth: -90, elevation: 0, distanceRatio: 2 }).x).toBeCloseTo(-3, 8);
    });

    test("round-trips a custom camera pose without depending on model scale", () => {
        const center = { x: -4, y: 3, z: 8 };
        const pose = { azimuth: 45, elevation: 30, distanceRatio: 3 };
        const recovered = cameraPoseFromPosition(cameraPositionForPose(center, 7, pose), center, 7);
        expect(recovered.azimuth).toBeCloseTo(45, 8);
        expect(recovered.elevation).toBeCloseTo(30, 8);
        expect(recovered.distanceRatio).toBeCloseTo(3, 8);
    });

    test("keeps the adjustable primary first and supplies stable left, right, and top references", () => {
        const primary = { azimuth: 35, elevation: 22, distanceRatio: 3.1 };
        expect(model3dViewPoses(primary)).toEqual([
            { id: "primary", pose: primary },
            { id: "left", pose: { azimuth: -90, elevation: 15, distanceRatio: DEFAULT_MODEL_3D_CAMERA.distanceRatio } },
            { id: "right", pose: { azimuth: 90, elevation: 15, distanceRatio: DEFAULT_MODEL_3D_CAMERA.distanceRatio } },
            { id: "top", pose: { azimuth: 0, elevation: 80, distanceRatio: DEFAULT_MODEL_3D_CAMERA.distanceRatio } },
        ]);
    });

    test("provides semantic Agent presets in model coordinates", () => {
        expect(MODEL_3D_CAMERA_PRESETS.front).toEqual({ azimuth: 0, elevation: 13, distanceRatio: 2.6 });
        expect(MODEL_3D_CAMERA_PRESETS.back.azimuth).toBe(180);
        expect(MODEL_3D_CAMERA_PRESETS.isometric).toEqual({ azimuth: 45, elevation: 25, distanceRatio: 2.6 });
    });
});
