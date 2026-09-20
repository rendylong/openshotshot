import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { MemorySection } from "./memory-section";

export const USER_MEMORY_BUDGET = 2000;

export type MemoryGuard = { dirty: boolean; confirmLeave: (proceed: () => void) => void };
export type MemoryGuardRef = React.RefObject<MemoryGuard | null>;

export function MemorySettingsSection({ guardRef, hidden }: { guardRef?: MemoryGuardRef; hidden?: boolean }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const [value, setValue] = useState("");
    const [baseline, setBaseline] = useState("");
    const loadedRef = useRef(false);
    const dirty = value !== baseline;

    const load = useCallback(async () => {
        const result = await window.shotshot?.agentMemory?.readUser();
        if (!result) return;
        if (!result.ok) {
            message.error(t("agent.memory.loadFailed"));
            return;
        }
        loadedRef.current = true;
        setBaseline(result.content);
        setValue(result.content);
    }, [message, t]);

    useEffect(() => {
        if (!loadedRef.current) void load();
    }, [load]);

    // 三键确认用受控小 Modal 渲染（antd Modal.confirm 无法自然承载三键）
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const proceedRef = useRef<() => void>(() => undefined);

    // 渲染期直接写 ref（刻意为之）：dirty 变化即时反映给弹窗外壳与 nav 拦截
    if (guardRef) guardRef.current = {
        dirty,
        confirmLeave: (proceed) => {
            if (!dirty) { proceed(); return; }
            proceedRef.current = proceed;
            setConfirmOpen(true);
        },
    };

    // 写盘并返回是否成功；成功 toast 由调用方决定（关闭路径组件即将卸载，省略 toast）
    const save = async (notifySuccess = true): Promise<boolean> => {
        const result = await window.shotshot?.agentMemory?.writeUser(value);
        if (!result) return false;
        if (!result.ok) {
            message.error(result.error);
            return false;
        }
        setBaseline(value);
        if (notifySuccess) message.success(t("agent.memory.saved"));
        return true;
    };

    const closeWithSave = async () => {
        setSaving(true);
        const ok = await save(false);
        setSaving(false);
        if (!ok) return;
        proceedRef.current();
        setConfirmOpen(false);
    };

    const clear = () => {
        modal.confirm({
            title: t("agent.memory.clearConfirm"),
            // Radix 设置弹窗打开时 body 为 pointer-events:none，portal 到 body 的浮层点不了；
            // false 渲染进 AntApp holder（弹窗内容子树）保持可交互。
            getContainer: false,
            onOk: () => {
                setValue("");
                setBaseline("");
                void window.shotshot?.agentMemory?.writeUser("");
                message.success(t("agent.memory.cleared"));
            },
        });
    };

    return (
        <div className={hidden ? "hidden" : "flex flex-col gap-4"}>
            <p className="text-xs text-stone-400 dark:text-stone-500">{t("settings.memory.description")}</p>
            <MemorySection
                title={t("agent.memory.user")}
                hint={t("agent.memory.userHint", { budget: USER_MEMORY_BUDGET })}
                budget={USER_MEMORY_BUDGET}
                value={value}
                onChange={setValue}
            />
            <div className="flex gap-3">
                <Button size="small" onClick={() => void save()}>{t("agent.memory.save")}</Button>
                <Button size="small" danger onClick={clear}>{t("agent.memory.clear")}</Button>
            </div>
            <Modal
                title={t("agent.memory.closeConfirmTitle")}
                open={confirmOpen}
                onCancel={() => setConfirmOpen(false)}
                footer={null}
                width={380}
                getContainer={false}
            >
                <p className="text-sm text-stone-500">{t("agent.memory.closeConfirmBody")}</p>
                <div className="mt-4 flex justify-end gap-2">
                    <Button size="small" type="primary" loading={saving} onClick={() => void closeWithSave()}>{t("agent.memory.closeSave")}</Button>
                    <Button size="small" onClick={() => { setValue(baseline); proceedRef.current(); setConfirmOpen(false); }}>{t("agent.memory.closeDiscard")}</Button>
                    <Button size="small" onClick={() => setConfirmOpen(false)}>{t("common.cancel")}</Button>
                </div>
            </Modal>
        </div>
    );
}
