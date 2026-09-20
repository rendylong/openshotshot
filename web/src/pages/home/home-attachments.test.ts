import { expect, it } from "vitest";
import { readHomeAttachments } from "./home-attachments";

it("reads a GLB without registering it in the old session", async () => {
    const [model] = await readHomeAttachments([new File(["fixture"], "bottle.glb", { type: "model/gltf-binary" })]);
    expect(model).toMatchObject({ name: "bottle.glb", kind: "glb" });
    expect(model.dataUrl).toMatch(/^data:/);
    expect(model.handle).toBeUndefined();
});
