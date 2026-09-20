export type Model3dCameraPose = {
    azimuth: number;
    elevation: number;
    distanceRatio: number;
};

export type Model3dViewId = "primary" | "left" | "right" | "top";
export type Model3dCameraPreset = "front" | "back" | "left" | "right" | "top" | "isometric";

type Vector3Like = { x: number; y: number; z: number };

export const DEFAULT_MODEL_3D_CAMERA: Model3dCameraPose = { azimuth: 0, elevation: 13, distanceRatio: 2.6 };

export const MODEL_3D_CAMERA_PRESETS: Record<Model3dCameraPreset, Model3dCameraPose> = {
    front: DEFAULT_MODEL_3D_CAMERA,
    back: { azimuth: 180, elevation: 13, distanceRatio: 2.6 },
    left: { azimuth: -90, elevation: 15, distanceRatio: 2.6 },
    right: { azimuth: 90, elevation: 15, distanceRatio: 2.6 },
    top: { azimuth: 0, elevation: 80, distanceRatio: 2.6 },
    isometric: { azimuth: 45, elevation: 25, distanceRatio: 2.6 },
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

function normalizeAzimuth(degrees: number) {
    const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
    return normalized === -180 && degrees > 0 ? 180 : normalized;
}

export function cameraPositionForPose(center: Vector3Like, radius: number, pose: Model3dCameraPose): Vector3Like {
    const distance = Math.max(Number.EPSILON, radius) * pose.distanceRatio;
    const azimuth = toRadians(pose.azimuth);
    const elevation = toRadians(pose.elevation);
    const horizontal = distance * Math.cos(elevation);
    return {
        x: center.x + horizontal * Math.sin(azimuth),
        y: center.y + distance * Math.sin(elevation),
        z: center.z + horizontal * Math.cos(azimuth),
    };
}

export function cameraPoseFromPosition(position: Vector3Like, center: Vector3Like, radius: number): Model3dCameraPose {
    const x = position.x - center.x;
    const y = position.y - center.y;
    const z = position.z - center.z;
    const distance = Math.hypot(x, y, z);
    const safeDistance = Math.max(Number.EPSILON, distance);
    return {
        azimuth: normalizeAzimuth(toDegrees(Math.atan2(x, z))),
        elevation: toDegrees(Math.asin(Math.max(-1, Math.min(1, y / safeDistance)))),
        distanceRatio: safeDistance / Math.max(Number.EPSILON, radius),
    };
}

export function model3dViewPoses(primary: Model3dCameraPose = DEFAULT_MODEL_3D_CAMERA): Array<{ id: Model3dViewId; pose: Model3dCameraPose }> {
    return [
        { id: "primary", pose: primary },
        { id: "left", pose: MODEL_3D_CAMERA_PRESETS.left },
        { id: "right", pose: MODEL_3D_CAMERA_PRESETS.right },
        { id: "top", pose: MODEL_3D_CAMERA_PRESETS.top },
    ];
}

