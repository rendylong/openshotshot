import { useState } from "react";
import { Alert, App, Button, Input, Modal, Space } from "antd";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { importLocalSkill, pickLocalFolder } from "@/services/local-skill";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    open: boolean;
    onClose: () => void;
};

export function SkillImportDialog({ open, onClose }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const scanSkills = useLocalSkillStore((state) => state.scanSkills);
    const [sourcePath, setSourcePath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);

    const reset = () => {
        setSourcePath(null);
        setError(null);
    };

    const chooseFolder = async () => {
        setError(null);
        const path = await pickLocalFolder();
        if (path) setSourcePath(path);
    };

    const submit = async () => {
        if (!sourcePath || importing) return;
        setImporting(true);
        setError(null);
        try {
            const result = await importLocalSkill(sourcePath);
            if (result?.error) {
                setError(result.error);
                return;
            }
            if (result) {
                await scanSkills();
                message.success(t("agent.skillManager.created"));
            }
            onClose();
        } finally {
            setImporting(false);
        }
    };

    return (
        <Modal
            title={t("skills.list.import")}
            open={open}
            okText={t("skills.list.import")}
            cancelText={t("common.cancel")}
            confirmLoading={importing}
            okButtonProps={{ disabled: !sourcePath || importing }}
            onCancel={() => {
                if (importing) return;
                reset();
                onClose();
            }}
            onOk={() => void submit()}
            afterClose={reset}
        >
            <div className="mb-3 text-xs" style={{ color: theme.node.muted }}>
                {t("skills.list.emptyHint")}
            </div>
            <Space.Compact className="w-full">
                <Input
                    readOnly
                    value={sourcePath ?? ""}
                    placeholder={t("skills.list.import")}
                    aria-label={t("skills.list.import")}
                />
                <Button icon={<FolderOpen className="size-4" />} onClick={() => void chooseFolder()}>
                    {t("agent.skills.selectLocal")}
                </Button>
            </Space.Compact>
            {error ? (
                <Alert
                    className="mt-3"
                    type="error"
                    showIcon
                    message={error}
                    aria-label={t("skills.list.import")}
                />
            ) : null}
        </Modal>
    );
}
