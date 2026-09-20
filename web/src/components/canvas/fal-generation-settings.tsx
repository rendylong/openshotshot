import { buildStrictGenerationContext, type NodeGenerationInput } from "./canvas-node-generation";
import type { ReferenceImage } from "@/types/image";
import { resolveImageUrl } from "@/services/image-storage";
import { compileFalInput } from "@/lib/models/fal/input";
import { useEffect, useMemo, useState } from "react";
import { Input, InputNumber, Select, Switch } from "antd";
import { useTranslation } from "react-i18next";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { FalProfile, JsonValue } from "@/lib/models/fal/profile-types";
import { patchProviderParams, readProviderParams, type ProviderOptions } from "@/lib/models/provider-options";
import { formatFalGenerationError } from "@/lib/models/fal/errors";
import { falCommonConfigKeys, falCommonMetadataKeys, falCommonValue, falNativeValue, validateFalSettings, falSettingsParams } from "@/lib/canvas/fal-settings";
import { useAssetMentionResolver } from "@/hooks/use-asset-mention";

export type FalGenerationSettingsProps = {
    profile: FalProfile;
    config: AiConfig;
    options?: ProviderOptions;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
};

export function FalGenerationSettings({ profile, config, options, onChange }: FalGenerationSettingsProps) {
    const { t } = useTranslation();
    const [changeError, setChangeError] = useState("");
    let params: Record<string, JsonValue> = {};
    let error = "";
    try { params = readProviderParams(options, config.model); validateFalSettings(profile, config, options); }
    catch (cause) { error = formatFalGenerationError(cause); }
    const properties = typeof profile.inputSchema === "object" ? profile.inputSchema.properties : {};
    const renderFields = (fields: FalProfile["fields"]) => fields.map(field => {
        const label = t(field.labelKey);
        const property = properties?.[field.name];
        const schemaDefault = typeof property === "object" ? property.default : undefined;
        const common = field.common && config[falCommonConfigKeys[field.common]];
        const value = field.common ? common !== undefined && common !== "" ? falNativeValue(field, common) : profile.defaults[field.name] : Object.hasOwn(params, field.name) ? params[field.name] : profile.defaults[field.name] ?? schemaDefault;
        const update = (next: JsonValue) => {
            try {
                const patch = field.common ? { [falCommonMetadataKeys[field.common]]: falCommonValue(field, next) } : { providerOptions: patchProviderParams(options, config.model, profile, { [field.name]: next }) };
                onChange(patch);
                setChangeError("");
            } catch (cause) { setChangeError(formatFalGenerationError(cause)); }
        };
        return <div key={field.name} className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="w-40 shrink-0">
                {field.kind === "enum" ? <Select aria-label={label} className="w-full" value={value === undefined ? undefined : String(value)} placeholder={t("fal.settings.defaultValue")} getPopupContainer={trigger => trigger.parentElement!} options={field.options?.map(option => ({ value: String(option), label: String(option) }))} onChange={next => update(field.options?.find(option => String(option) === next) ?? next)} />
                    : field.kind === "boolean" ? <div className="flex items-center justify-end gap-2"><Switch aria-label={label} checked={value === true} onChange={update} />{value !== undefined && typeof value !== "boolean" ? <span className="text-xs text-danger">{String(value)}</span> : null}</div>
                    : field.kind === "number" ? <InputNumber aria-label={label} className="w-full" value={value as number | null | undefined} placeholder={t("fal.settings.defaultValue")} onChange={update} />
                    : <Input aria-label={label} value={value === undefined ? "" : String(value)} placeholder={t("fal.settings.defaultValue")} onChange={event => update(event.target.value)} />}
            </div>
        </div>;
    });
    return <div className="space-y-3 text-foreground" onMouseDown={event => event.stopPropagation()}>
        {renderFields(profile.fields.filter(field => field.common || !field.advanced))}
        {profile.fields.some(field => field.advanced && !field.common) ? <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">{t("fal.settings.advanced")}</summary>
            <div className="mt-3 space-y-3">{renderFields(profile.fields.filter(field => field.advanced && !field.common))}</div>
        </details> : null}
        {profile.media.length ? <div className="space-y-1 text-xs text-muted-foreground">
            {profile.media.map((slot, index) => <p key={slot.field}>{t(`fal.settings.${slot.role}`, { index: index + 1 })} · {t(slot.required ? "fal.settings.required" : "fal.settings.optional")}</p>)}
        </div> : null}
        {error || changeError ? <p role="alert" className="break-words text-xs text-danger">{error || changeError}</p> : null}
    </div>;
}

const EMPTY_SOURCE_IMAGES: ReferenceImage[] = [];

// Shared by the config composer and ordinary image/video prompt panels.
export function FalGenerationMedia({ profile, config, options, inputs, prompt, composerMode = false, sourceImages = EMPTY_SOURCE_IMAGES }: Omit<FalGenerationSettingsProps, "onChange"> & { inputs: NodeGenerationInput[]; prompt: string; composerMode?: boolean; sourceImages?: ReferenceImage[] }) {
    const { t } = useTranslation();
    const resolveAsset = useAssetMentionResolver();
    const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
    const preview = useMemo(() => {
        try {
            const context = buildStrictGenerationContext(inputs, prompt, composerMode || /@\[node:[^\]]+\]/.test(prompt), sourceImages, resolveAsset);
            let error = "";
            try { compileFalInput(profile, { prompt: context.prompt || "Preview", images: context.referenceImages.map(() => "https://reference.invalid/preview.png"), audios: context.referenceAudios.map(ref => ref.url), videos: context.referenceVideos.map(ref => ref.url), params: falSettingsParams(profile, config, options) }); }
            catch (cause) { error = formatFalGenerationError(cause); }
            return { context, error };
        } catch (cause) { return { error: formatFalGenerationError(cause) }; }
    }, [inputs, prompt, composerMode, sourceImages, resolveAsset, profile, config, options, t]);
    const images = preview.context?.referenceImages;
    useEffect(() => {
        let cancelled = false;
        setThumbnails({});
        void Promise.all((images || []).map(async ref => {
            // A stored item is authoritative, never fall back to another item's primary image.
            const url = await resolveImageUrl(ref.storageKey, ref.storageKey ? "" : ref.dataUrl || ref.url || "").catch(() => "");
            return [referenceKey(ref), url] as const;
        })).then(entries => { if (!cancelled) setThumbnails(Object.fromEntries(entries)); });
        return () => { cancelled = true; };
    }, [images]);
    let index = 0;
    const bindings = profile.media.flatMap(slot => {
        const refs = slot.mode === "many" ? (images || []).slice(index) : (images || []).slice(index, index + 1);
        const start = index;
        index += refs.length;
        return (refs.length ? refs : [undefined]).map((ref, offset) => ({ ref, label: t(`fal.settings.${slot.role}`, { index: start + offset + 1 }), required: slot.required }));
    });
    for (const ref of (images || []).slice(index)) bindings.push({ ref, label: t("fal.settings.extra", { index: ++index }), required: false });
    if (!bindings.length && !preview.error) return null;
    return <div className="mt-2 space-y-2 text-xs" aria-label={t("fal.settings.preview")}>
        <div className="font-medium text-muted-foreground">{t("fal.settings.preview")}</div>
        <div className="flex flex-wrap gap-3">{bindings.map((binding, position) => <div key={position} className="flex items-center gap-2">
            {binding.ref && thumbnails[referenceKey(binding.ref)] ? <img className="size-10 rounded-md object-contain" src={thumbnails[referenceKey(binding.ref)]} alt={`${binding.label} · ${binding.ref.name}`} /> : null}
            <div><div>{binding.label} · {t(binding.required ? "fal.settings.required" : "fal.settings.optional")}</div><div className="max-w-40 truncate text-muted-foreground">{binding.ref?.name || t("fal.settings.missing")}</div></div>
        </div>)}</div>
        {preview.error ? <p role="alert" className="break-words text-danger">{preview.error}</p> : null}
        <details><summary className="cursor-pointer text-muted-foreground">{t("fal.settings.compiledPrompt")}</summary><p className="mt-1 whitespace-pre-wrap break-words">{preview.context?.prompt}</p></details>
        <p className="text-muted-foreground">{t("fal.settings.mediaCheck")}</p>
    </div>;
}
function referenceKey(ref: ReferenceImage) { return `${ref.id}:${ref.storageKey || ""}`; }
