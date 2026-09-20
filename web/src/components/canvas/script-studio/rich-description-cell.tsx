import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ScriptRichSegment, ScriptShot } from "@/types/script-node";
import { chipHtml, deriveDescription, deriveEntityRefs, escapeHtml, htmlToRich, richToHtml, type ScriptEntityGroupLike } from "@/lib/canvas/script-node-model";

export type RichEntityMeta = { id: string; name: string; group: ScriptEntityGroupLike; ready: boolean };

type Props = {
    shot: ScriptShot;
    /** cell = 表格/列表内嵌尺寸；inspector = 右侧检查器全宽（rich-desc--inspector） */
    variant?: "cell" | "inspector";
    entities: RichEntityMeta[];
    onChange: (patch: Partial<Pick<ScriptShot, "descriptionRich" | "description" | "entityRefs">>) => void;
    onDuplicateRef?: (name: string) => void;
    /** @ 弹层空态的引导动作：跳到「准备资产」 */
    onGoAssets?: () => void;
    /** @ 浮层「新建资产」：创建/挂接实体并挂到当前脚本（ScriptStudio 注入）；未传则不渲染新建行 */
    onCreateAsset?: (name: string, group: ScriptEntityGroupLike) => RichEntityMeta;
};

type PickerState = { query: string; active: number; items: RichEntityMeta[]; group: ScriptEntityGroupLike } | null;

const GROUP_ORDER: ScriptEntityGroupLike[] = ["character", "scene", "item"];
const GROUP_LABEL_KEY: Record<ScriptEntityGroupLike, string> = {
    character: "canvas.scriptAssets.groupCharacter",
    scene: "canvas.scriptAssets.groupScene",
    item: "canvas.scriptAssets.groupItem",
};

/** 新建行可见性（spec D7 合取条件）：谓词查本脚本挂载实体；项目级同名由 createOrAttachAsset 兜底 */
const isCreateVisible = (picker: PickerState, entities: RichEntityMeta[], hasCreate: boolean): boolean =>
    Boolean(hasCreate && picker && picker.query !== "" && !entities.some((e) => e.name === picker.query));

/**
 * 镜头描述的富文本单元格：输入 @ 弹实体选择浮层（↑↓/Enter/Esc），
 * 选中的资产以不可拆分的内联胶囊嵌在光标处；胶囊删除即解除引用。
 * 查询词无同名资产时浮层尾部出现「新建资产」行（名称即查询词、行内切分组、Enter 创建即插胶囊）。
 */
export function RichDescriptionCell({ shot, variant, entities, onChange, onDuplicateRef, onGoAssets, onCreateAsset }: Props) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement | null>(null);
    const pickerRef = useRef<HTMLDivElement | null>(null);
    const [picker, setPicker] = useState<PickerState>(null);

    const metaOf = (id: string) => {
        const entity = entities.find((e) => e.id === id);
        return entity ? { name: entity.name, group: entity.group } : undefined;
    };

    // 仅在镜头切换时重设内容，避免打断输入。
    useEffect(() => {
        if (ref.current) ref.current.innerHTML = richToHtml(shot.descriptionRich, metaOf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shot.shotId]);

    const sync = (created?: { id: string; name: string }) => {
        const el = ref.current;
        if (!el) return;
        const rich = htmlToRich(el);
        // created 覆写：新实体尚未回流到 props，直接查会把它解析成 ""，创建瞬间的 description 会缺名
        const nameOf = (id: string) => (created && id === created.id ? created.name : entities.find((e) => e.id === id)?.name);
        onChange({
            descriptionRich: rich,
            description: deriveDescription(rich, nameOf),
            entityRefs: deriveEntityRefs(rich),
        });
    };

    const caretTextBefore = (el: HTMLElement): string => {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return "";
        const range = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString();
    };

    const hidePicker = () => {
        pickerRef.current?.remove();
        pickerRef.current = null;
        setPicker(null);
    };

    const showPicker = (query: string) => {
        const items = entities.filter((e) => !query || e.name.includes(query));
        hidePicker();
        // group 跨键入保持：showPicker 每次键入都会重建 state（active 随之归零），只有关闭后再打开才回默认角色
        setPicker({ query, active: 0, items, group: picker?.group ?? "character" });
    };

    // 浮层随 picker state 渲染到 body（fixed 定位贴输入框下沿）
    useEffect(() => {
        if (!picker || !ref.current) return;
        const createVisible = isCreateVisible(picker, entities, Boolean(onCreateAsset));
        const host = document.createElement("div");
        host.className = "entity-picker text-sm";
        const createRowHtml = createVisible
            ? `<div class="ep-divider" aria-hidden></div><div class="ep-item ep-create${picker.active === picker.items.length ? " active" : ""}" data-create><span class="ep-create-label">${t("canvas.scriptStudio.pickerCreate", { name: escapeHtml(picker.query) })}</span><span class="ep-groups">${GROUP_ORDER.map(
                  (g) => `<button type="button" class="ep-group-chip${picker.group === g ? " active" : ""}" data-group="${g}">${t(GROUP_LABEL_KEY[g])}</button>`,
              ).join("")}</span></div>`
            : "";
        host.innerHTML =
            (picker.items.length
                ? picker.items
                      .map(
                          (e, i) =>
                              `<div class="ep-item${i === picker.active ? " active" : ""}" data-entity-id="${e.id}">${escapeHtml(e.name)}<span class="ml-auto text-[11px] opacity-50">${e.group}${e.ready ? ` · ${t("canvas.scriptStudio.pickerKindReady")}` : ` · ${t("canvas.scriptStudio.pickerKindEmpty")}`}</span></div>`,
                      )
                      .join("")
                : createVisible
                  ? ""
                  : `<div class="ep-item ep-empty"><span>${t("canvas.scriptStudio.pickerEmpty")}</span>${onGoAssets ? `<button type="button" class="ep-action" data-go-assets>${t("canvas.scriptStudio.goAssets")}</button>` : ""}</div>`) + createRowHtml;
        host.querySelectorAll<HTMLElement>("[data-entity-id]").forEach((item) => {
            item.addEventListener("mousedown", (event) => {
                event.preventDefault();
                const entity = entities.find((e) => e.id === item.dataset.entityId);
                if (entity) pickEntity(entity.id, entity.name, entity.group);
            });
        });
        host.querySelectorAll<HTMLElement>("[data-group]").forEach((chip) => {
            chip.addEventListener("mousedown", (event) => {
                event.preventDefault();
                event.stopPropagation(); // chip 只切档位，不冒泡到新建行触发创建
                setPicker((p) => (p && chip.dataset.group ? { ...p, group: chip.dataset.group as ScriptEntityGroupLike } : p));
            });
        });
        const createRow = host.querySelector<HTMLElement>("[data-create]");
        if (createRow) {
            createRow.addEventListener("mousedown", (event) => {
                event.preventDefault();
                createAsset();
            });
        }
        const goBtn = host.querySelector<HTMLElement>("[data-go-assets]");
        if (goBtn) {
            goBtn.addEventListener("mousedown", (event) => {
                event.preventDefault();
                hidePicker();
                onGoAssets?.();
            });
        }
        document.body.appendChild(host);
        pickerRef.current = host;
        const rect = ref.current.getBoundingClientRect();
        host.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
        host.style.top = `${rect.bottom + 4}px`;
        host.querySelector<HTMLElement>(".ep-item.active")?.scrollIntoView({ block: "nearest" });
        return () => {
            host.remove();
            if (pickerRef.current === host) pickerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picker]);

    const stripAtBeforeCaret = (el: HTMLElement) => {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) return;
        const text = node.textContent ?? "";
        const match = text.slice(0, range.startOffset).match(/@([^\s@]*)$/);
        if (!match) return;
        const cut = range.startOffset - match[0].length;
        node.textContent = text.slice(0, cut) + text.slice(range.startOffset);
        range.setStart(node, cut);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    };

    const pickEntity = (entityId: string, name: string, group: ScriptEntityGroupLike, created?: { id: string; name: string }) => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        hidePicker();
        if (shot.entityRefs.includes(entityId)) {
            stripAtBeforeCaret(el);
            sync(created);
            onDuplicateRef?.(name);
            return;
        }
        stripAtBeforeCaret(el);
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const range = sel.getRangeAt(0);
        const template = document.createElement("div");
        template.innerHTML = chipHtml(entityId, { name, group });
        const chip = template.firstElementChild;
        if (!chip) return;
        range.insertNode(chip);
        const space = document.createTextNode("\u00A0");
        chip.after(space);
        range.setStartAfter(space);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        sync(created);
    };

    const createAsset = () => {
        if (!picker || !onCreateAsset) return;
        const meta = onCreateAsset(picker.query, picker.group);
        pickEntity(meta.id, meta.name, meta.group, { id: meta.id, name: meta.name });
    };

    const handleInput = () => {
        const el = ref.current;
        if (!el) return;
        sync();
        const match = caretTextBefore(el).match(/@([^\s@]*)$/);
        if (match) showPicker(match[1]);
        else hidePicker();
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!picker) return;
        const createVisible = isCreateVisible(picker, entities, Boolean(onCreateAsset));
        const total = picker.items.length + (createVisible ? 1 : 0);
        const createActive = createVisible && picker.active === picker.items.length;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!total) return;
            setPicker({ ...picker, active: (picker.active + (event.key === "ArrowDown" ? 1 : total - 1)) % total });
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            if (!createActive) return;
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 1 : GROUP_ORDER.length - 1;
            setPicker({ ...picker, group: GROUP_ORDER[(GROUP_ORDER.indexOf(picker.group) + delta) % GROUP_ORDER.length] });
        } else if (event.key === "Enter") {
            if (createActive) {
                if (event.nativeEvent.isComposing) return; // IME 组合期确认候选词，不触发创建（仅创建分支，不动既有选中）
                event.preventDefault();
                createAsset();
            } else if (picker.items.length) {
                event.preventDefault();
                const entity = picker.items[picker.active];
                if (!entity) return; // stale-active：active 越界（如浮层打开期间实体集翻转）时静默忽略，防 TypeError
                pickEntity(entity.id, entity.name, entity.group);
            }
        } else if (event.key === "Escape") {
            hidePicker();
        }
    };

    return (
        <div
            ref={ref}
            className={`rich-desc text-sm ${variant === "inspector" ? "rich-desc--inspector w-full" : ""}`}
            contentEditable
            suppressContentEditableWarning
            data-placeholder={t("canvas.scriptStudio.descPlaceholder")}
            onInput={handleInput}
            onBlur={() => {
                hidePicker();
                sync();
            }}
            onKeyDown={handleKeyDown}
        />
    );
}
