import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

type Props = {
    /** 检查器 label[htmlFor] 关联（表格用法不传，靠 aria-label） */
    id?: string;
    value: string;
    options: string[];
    placeholder?: string;
    ariaLabel?: string;
    onChange: (value: string) => void;
};

/**
 * 镜头表格的词汇单元格：建议词可选、任意文本可输。
 * 展开 = 点 chevron（强制全量）/ 收起态 ↓↑ / 键入有匹配；普通 focus 不弹层。
 * 空输入展全量、有匹配按包含过滤、零匹配即收起；键盘 ↑↓ 循环、Enter 提交、Esc/失焦/滚动/resize 收起。
 */
export function ShotCellCombo({ id, value, options, placeholder, ariaLabel, onChange }: Props) {
    const listboxId = useId();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    // null = 不过滤（全量浏览，如 chevron 展开/越界值）；否则按该串做包含过滤
    const [query, setQuery] = useState<string | null>(null);
    const [anchor, setAnchor] = useState<{ left: number; top: number; minWidth: number } | null>(null);

    const visible = useMemo(() => {
        if (query === null) return options;
        const q = query.toLowerCase();
        return options.filter((opt) => opt.toLowerCase().includes(q));
    }, [options, query]);

    const openAt = (withQuery: string | null, activeIndex: number) => {
        const rect = inputRef.current?.getBoundingClientRect();
        if (!rect) return;
        // 视口底部放不下时向上翻转（预估高：选项行高 + 内边距，受 max-height 240 封顶）
        const count = withQuery === null ? options.length : filtered(withQuery).length;
        const estimated = Math.min(count * 33 + 10, 240);
        const flip = rect.bottom + 4 + estimated > window.innerHeight && rect.top - 4 - estimated >= 4;
        const top = flip ? rect.top - 4 - estimated : rect.bottom + 4;
        setAnchor({ left: rect.left, top, minWidth: rect.width });
        setQuery(withQuery);
        setActive(activeIndex);
        setOpen(true);
    };

    const close = () => {
        setOpen(false);
        setQuery(null);
    };

    const commit = (next: string) => {
        onChange(next);
        close();
    };

    const filtered = (text: string) => {
        const q = text.toLowerCase();
        return options.filter((opt) => opt.toLowerCase().includes(q));
    };

    const handleChange = (next: string) => {
        onChange(next);
        const hits = filtered(next);
        if (hits.length) {
            // 键入产生匹配：未展开则展开，展开中保持过滤并回到首项高亮
            if (!open) openAt(next, 0);
            else {
                setQuery(next);
                setActive(0);
            }
        } else if (open) {
            close(); // 零匹配即收起（无空态文案）
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
                // 收起态 ↓/↑：展开（值有匹配按值过滤，否则全量）并高亮首/末项
                const hits = filtered(value);
                openAt(hits.length ? value : null, event.key === "ArrowDown" ? 0 : Math.max(0, (hits.length || options.length) - 1));
                return;
            }
            const count = visible.length;
            if (!count) return;
            setActive((active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const hit = visible[active];
            if (hit !== undefined) commit(hit);
        } else if (event.key === "Escape" && open) {
            // 仅收起不回滚（值已逐键提交），且不冒泡给外层（如 studio 关闭）
            event.stopPropagation();
            close();
        }
        // Tab：键入值已逐键提交，失焦即收起，走默认行为
    };

    // 高亮项变化时滚入浮层可视区（长列表键盘导航不失踪）
    useEffect(() => {
        if (!open) return;
        document.getElementById(`${listboxId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
    }, [active, open, listboxId]);

    // 滚动/resize 收起防浮层脱锚；document pointerdown 保险：chevron preventDefault 路径下
    // 焦点可能不在 input 上，点外部（含其他单元格的 chevron）也必须收起，防孤儿弹层误提交
    useEffect(() => {
        if (!open) return;
        const closeOn = () => close();
        const closeOnPointer = (event: PointerEvent) => {
            const target = event.target as Element | null;
            if (wrapRef.current?.contains(target)) return;
            if (target?.closest?.(".script-cell-combo-popup")) return;
            close();
        };
        window.addEventListener("scroll", closeOn, true);
        window.addEventListener("resize", closeOn);
        document.addEventListener("pointerdown", closeOnPointer);
        return () => {
            window.removeEventListener("scroll", closeOn, true);
            window.removeEventListener("resize", closeOn);
            document.removeEventListener("pointerdown", closeOnPointer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    return (
        <div ref={wrapRef} className="relative flex items-center">
            <input
                ref={inputRef}
                id={id}
                className="script-cell-input pr-5"
                type="text"
                value={value}
                placeholder={placeholder}
                title={value || undefined}
                aria-label={ariaLabel}
                role="combobox"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-autocomplete="list"
                aria-activedescendant={open && visible[active] !== undefined ? `${listboxId}-opt-${active}` : undefined}
                onBlur={close}
                onChange={(event) => handleChange(event.target.value)}
                onKeyDown={handleKeyDown}
            />
            <button
                type="button"
                tabIndex={-1}
                aria-hidden
                className="absolute right-1 flex size-5 items-center justify-center text-stone-400"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                    // 显式聚焦：让 blur/Esc/点外部的关闭生命周期对 chevron 路径同样生效
                    if (open) {
                        close();
                        return;
                    }
                    inputRef.current?.focus();
                    openAt(null, Math.max(0, options.indexOf(value)));
                }}
            >
                <ChevronDown className="size-3" aria-hidden />
            </button>
            {open &&
                visible.length > 0 &&
                createPortal(
                    <div
                        role="listbox"
                        id={listboxId}
                        className="script-cell-combo-popup"
                        style={{ left: anchor?.left, top: anchor?.top, minWidth: anchor?.minWidth }}
                    >
                        {visible.map((opt, i) => (
                            <div
                                key={opt}
                                role="option"
                                id={`${listboxId}-opt-${i}`}
                                aria-selected={opt === value}
                                className={`ep-item${i === active ? " active" : ""}`}
                                // preventDefault 保住 input 焦点，避免 blur 先于提交收起浮层
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    commit(opt);
                                }}
                                onMouseEnter={() => setActive(i)}
                            >
                                {opt}
                            </div>
                        ))}
                    </div>,
                    document.body,
                )}
        </div>
    );
}
