import { useCallback, useEffect, useRef, useState } from "react";
import { App, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { MemorySection } from "./memory-section";

export const PROJECT_MEMORY_BUDGET = 3000;

export type MemoryProjectGuard = { dirty: boolean; confirmLeave: (proceed: () => void) => void };

export function MemoryProjectSettings({ workspacePath, guardRef }: { workspacePath?: string; guardRef?: React.RefObject<MemoryProjectGuard | null> }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const [value, setValue] = useState("");
    const [baseline, setBaseline] = useState("");
    const loadedPathRef = useRef<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const proceedRef = useRef<() => void>(() => undefined);
    const dirty = !!workspacePath && value !== baseline;

    const load = useCallback(async () => {
        if (!workspacePath) return;
        const result = await window.shotshot?.agentMemory?.readProject(workspacePath);
        if (!result) return;
        if (!result.ok) {
            message.error(t("agent.memory.loadFailed"));
            return;
        }
        loadedPathRef.current = workspacePath;
        setBaseline(result.content);
        setValue(result.content);
    }, [message, t, workspacePath]);

    useEffect(() => {
        if (workspacePath && loadedPathRef.current !== workspacePath) void load();
    }, [load, workspacePath]);

    const [saving, setSaving] = useState(false);
    // T2 评审裁定：save 返回 boolean；「保存并关闭」await 失败不关闭不丢编辑（错误 toast 在组件挂载下可见）
    const save = async (): Promise<boolean> => {
        if (!workspacePath) return false;
        const result = await window.shotshot?.agentMemory?.writeProject(workspacePath, value);
        if (!result) return false;
        if (result.ok) {
            setBaseline(value);
            message.success(t("agent.memory.saved"));
            return true;
        }
        message.error(result.error);
        return false;
    };

    const clear = () => {
        modal.confirm({
            title: t("agent.memory.clearConfirm"),
            onOk: () => {
                setValue("");
                setBaseline("");
                if (workspacePath) void window.shotshot?.agentMemory?.writeProject(workspacePath, "");
                message.success(t("agent.memory.cleared"));
            },
        });
    };

    if (guardRef) guardRef.current = {
        dirty,
        confirmLeave: (proceed) => {
            if (!dirty) { proceed(); return; }
            proceedRef.current = proceed;
            setConfirmOpen(true);
        },
    };

    return (
        <div className="flex flex-col gap-4">
            <MemorySection
                title={t("agent.memory.project")}
                hint={t("agent.memory.projectHint", { budget: PROJECT_MEMORY_BUDGET })}
                disabled={!workspacePath}
                disabledHint={t("agent.memory.projectUnavailable")}
                budget={PROJECT_MEMORY_BUDGET}
                value={value}
                onChange={setValue}
            />
            <div className="flex gap-3">
                <button type="button" className="cursor-pointer text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" disabled={!workspacePath} onClick={() => void save()}>{t("agent.memory.save")}</button>
                <button type="button" className="cursor-pointer text-xs text-red-500 opacity-75 hover:opacity-100" disabled={!workspacePath} onClick={clear}>{t("agent.memory.clear")}</button>
            </div>
            <Modal
                title={t("agent.memory.closeConfirmTitle")}
                open={confirmOpen}
                onCancel={() => setConfirmOpen(false)}
                footer={null}
                width={380}
            >
                <p className="text-sm text-stone-500">{t("agent.memory.closeConfirmBody")}</p>
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={saving} className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs text-white disabled:opacity-60" onClick={() => { void (async () => { setSaving(true); const ok = await save(); setSaving(false); if (!ok) return; proceedRef.current(); setConfirmOpen(false); })(); }}>{t("agent.memory.closeSave")}</button>
                    <button type="button" className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs" onClick={() => { setValue(baseline); proceedRef.current(); setConfirmOpen(false); }}>{t("agent.memory.closeDiscard")}</button>
                    <button type="button" className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs" onClick={() => setConfirmOpen(false)}>{t("common.cancel")}</button>
                </div>
            </Modal>
        </div>
    );
}
