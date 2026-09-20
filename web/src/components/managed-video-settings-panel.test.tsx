import { useState } from "react";
import { managedVideoProfile } from "@/lib/models/managed-video-profiles";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { VideoSettingsPanel } from "./video-settings-panel";
import { CanvasVideoSettingsPopover } from "./canvas/canvas-video-settings-popover";
const catalog = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock("@/lib/desktop/use-managed-catalog", () => ({ useManagedCatalog: () => catalog }));
const spec = { resolution: "768p横", orientation: "landscape", quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } };
const config = { ...defaultConfig, credentialMode: "shotshot" as const, credentialModes: { ...defaultConfig.credentialModes, video: "shotshot" as const }, managedModels: { ...defaultConfig.managedModels, video: "minimax_h3_lightx2v_v5" }, vquality: "768p横", size: "1024x1024", videoSeconds: "5" };
beforeEach(() => { void i18n.changeLanguage("en-US"); catalog.models = [{ id: "minimax_h3_lightx2v_v5", capability: "video", video_specs: [spec, { ...spec, resolution: "768p竖", orientation: "portrait" }, { ...spec, resolution: "768p(1:1)", orientation: "square" }] }]; });
describe("managed video panel", () => {
 it("renders resolution and aspect ratio as separate setting groups", () => {
  render(<VideoSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={vi.fn()} />);
  const headings = screen.getAllByText(/^(Resolution|Aspect ratio)$/).map(element => element.textContent);
  expect(headings).toEqual(["Resolution", "Aspect ratio"]);
 });
 it("shows only executable choices and saves the exact selected token", () => {
  const onConfigChange = vi.fn();
  render(<VideoSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
  expect(screen.getByRole("button", { name: "Landscape" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
  expect(onConfigChange).toHaveBeenCalledWith("vquality", "768p竖");
  fireEvent.click(screen.getByRole("button", { name: "Square" }));
  expect(onConfigChange).toHaveBeenCalledWith("vquality", "768p(1:1)");
  expect(screen.queryByText("1280×720")).toBeNull();
  expect(screen.getByRole("spinbutton")).toHaveAttribute("max", "10");
 });
 it("requires reselection for legacy generic settings without rewriting the node", () => {
  const onConfigChange = vi.fn();
  render(<VideoSettingsPanel config={{ ...config, vquality: "720" }} theme={canvasThemes.dark} onConfigChange={onConfigChange} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a resolution and aspect ratio");
  expect(onConfigChange).not.toHaveBeenCalled();
 });
 it("does not fall back to generic settings when the catalog is missing", () => {
  catalog.models = [];
  render(<VideoSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Video options are unavailable");
  expect(screen.queryByRole("button", { name: "Landscape" })).toBeNull();
 });
 it("renders catalog capabilities when the public model id differs from the upstream workflow id", () => {
  catalog.models = [{ id: "video-pro", capability: "video", video_specs: [spec, { ...spec, resolution: "768p竖", orientation: "portrait" }] }];
  render(<VideoSettingsPanel config={{ ...config, managedModels: { ...config.managedModels, video: "video-pro" } }} theme={canvasThemes.light} onConfigChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "768p" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Landscape" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("alert")).toBeNull();
 });
 it("summary uses the selected spec rather than old square dimensions", () => {
  render(<CanvasVideoSettingsPopover config={config} onConfigChange={vi.fn()} />);
  expect(screen.getByRole("button")).toHaveTextContent("768p · Landscape · 5s");
 });
});

function InteractivePanel() {
 const [value, setValue] = useState({ ...config, managedModels: { ...config.managedModels, video: "minimax_h3_image_audio_to_video_v2" } });
 return <VideoSettingsPanel config={value} theme={canvasThemes.light} onConfigChange={(key, next) => setValue(current => ({ ...current, [key]: next }))} />;
}
it("separates quality and orientation and preserves landscape when selecting 1080p", () => {
 const id = "minimax_h3_image_audio_to_video_v2";
 catalog.models = [{ id, capability: "video", video_specs: managedVideoProfile(id)!.specs }];
 render(<InteractivePanel />);
 fireEvent.click(screen.getByRole("button", { name: "1080p" }));
 expect(screen.getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
 expect(screen.getByRole("button", { name: "Landscape" })).toHaveAttribute("aria-pressed", "true");
 expect(screen.queryByRole("button", { name: "Square" })).toBeNull();
 expect(screen.queryByRole("alert")).toBeNull();
 fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "11" } });
 expect(screen.getByRole("alert")).toBeInTheDocument();
});
it("clears the selected orientation when it is unavailable at the new quality", () => {
 const id = "minimax_h3_lightx2v_v5";
 catalog.models = [{ id, capability: "video", video_specs: managedVideoProfile(id)!.specs.filter(s => s.resolution !== "480p(1:1)") }];
 const onConfigChange = vi.fn();
 render(<VideoSettingsPanel config={{ ...config, vquality: "768p(1:1)" }} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
 fireEvent.click(screen.getByRole("button", { name: "480p" }));
 expect(onConfigChange).toHaveBeenCalledWith("vquality", "480p");
});
it("rejects a stale choice after switching to a model without 1080p", () => {
 render(<VideoSettingsPanel config={{ ...config, vquality: "1080p横" }} theme={canvasThemes.light} onConfigChange={vi.fn()} />);
 expect(screen.getByRole("alert")).toBeInTheDocument();
 expect(screen.queryByRole("button", { name: "1080p" })).toBeNull();
});
