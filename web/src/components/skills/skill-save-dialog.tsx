import { useMemo, useState } from "react";
import { Alert, App, Form, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { parseSkillMarkdown, SKILL_NAME_PATTERN } from "@/lib/skills/skill-format";
import { writeLocalSkill } from "@/services/local-skill";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    raw: string;
    onClose: () => void;
    onSaved?: (name: string) => void;
};

type FormValues = {
    name: string;
    description: string;
    instructions: string;
    displayName?: string;
    shortDescription?: string;
};

export function SkillSaveDialog({ raw, onClose, onSaved }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const scanSkills = useLocalSkillStore((state) => state.scanSkills);
    const [form] = Form.useForm<FormValues>();
    const parsed = useMemo(() => parseSkillMarkdown(raw), [raw]);
    const [saving, setSaving] = useState(false);
    const [writtenName, setWrittenName] = useState<string | null>(null);

    const submit = async () => {
        let values: FormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        setSaving(true);
        try {
            const name = writtenName || values.name.trim();
            if (!writtenName) {
                const result = await writeLocalSkill(name, {
                    description: values.description.trim(),
                    instructions: values.instructions.trim(),
                    displayName: values.displayName?.trim() || null,
                    shortDescription: values.shortDescription?.trim() || null,
                });
                if (!result.ok) {
                    message.error(result.error || t("agent.skillManager.saveFailed"));
                    return;
                }
                setWrittenName(name);
            }
            const refreshed = await scanSkills();
            if (!refreshed.ok) {
                message.error(refreshed.error || t("agent.skillManager.saveFailed"));
                return;
            }
            message.success(t("agent.skillManager.created"));
            onSaved?.(name);
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title={t("agent.skillManager.createSkill")}
            open
            okText={t("agent.skillManager.createSkill")}
            cancelText={t("common.cancel")}
            confirmLoading={saving}
            width={680}
            centered
            destroyOnHidden
            styles={{ body: { maxHeight: "calc(100vh - 220px)", overflowY: "auto" } }}
            onCancel={() => {
                if (saving) return;
                onClose();
            }}
            onOk={() => void submit()}
        >
            {!parsed.ok ? (
                <Alert type="error" showIcon message={parsed.error} />
            ) : (
                <>
                    <div className="mb-5 text-xs" style={{ color: theme.node.muted }}>
                        {t("agent.skillManager.saveLocation")}
                    </div>
                    {writtenName ? <Alert className="mb-4" type="info" showIcon message={t("agent.skillManager.refreshOnly")} /> : null}
                    <Form
                        form={form}
                        disabled={Boolean(writtenName)}
                        layout="vertical"
                        requiredMark="optional"
                        preserve={false}
                        initialValues={{
                            name: parsed.skill.name,
                            description: parsed.skill.description,
                            instructions: parsed.skill.instructions,
                            displayName: parsed.skill.displayName || undefined,
                            shortDescription: parsed.skill.shortDescription || undefined,
                        }}
                    >
                        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                            <Form.Item
                                name="name"
                                label={t("agent.skillManager.identifier")}
                                extra={t("agent.skillManager.identifierExtra")}
                                rules={[
                                    { required: true, message: t("agent.skillManager.identifierRequired") },
                                    { max: 64, message: t("agent.skillManager.identifierMax") },
                                    { pattern: SKILL_NAME_PATTERN, message: t("agent.skillManager.identifierPattern") },
                                ]}
                            >
                                <Input maxLength={64} placeholder={t("agent.skillManager.identifierPlaceholder")} />
                            </Form.Item>
                            <Form.Item
                                name="displayName"
                                label={t("agent.skillManager.displayName")}
                                rules={[{ max: 64, message: t("agent.skillManager.displayNameMax") }]}
                            >
                                <Input maxLength={64} placeholder={t("agent.skillManager.displayNamePlaceholder")} />
                            </Form.Item>
                        </div>
                        <Form.Item
                            name="description"
                            label={t("agent.skillManager.whenToUse")}
                            extra={t("agent.skillManager.whenToUseExtra")}
                            rules={[
                                { required: true, message: t("agent.skillManager.whenToUseRequired") },
                                { max: 1024, message: t("agent.skillManager.whenToUseMax") },
                                { validator: (_, value) => (typeof value === "string" && /[<>]/.test(value) ? Promise.reject(new Error(t("agent.skillManager.noAngleBrackets"))) : Promise.resolve()) },
                            ]}
                        >
                            <Input.TextArea maxLength={1024} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("agent.skillManager.whenToUsePlaceholder")} />
                        </Form.Item>
                        <Form.Item
                            name="instructions"
                            label={t("agent.skillManager.instructions")}
                            extra={t("agent.skillManager.instructionsExtra")}
                            rules={[{ required: true, message: t("agent.skillManager.instructionsRequired") }]}
                        >
                            <Input.TextArea className="!leading-6" autoSize={{ minRows: 6, maxRows: 10 }} placeholder={t("agent.skillManager.instructionsPlaceholder")} />
                        </Form.Item>
                        <Form.Item
                            name="shortDescription"
                            label={t("agent.skillManager.shortDescription")}
                            rules={[{ max: 64, message: t("agent.skillManager.shortDescriptionMax") }]}
                        >
                            <Input maxLength={64} placeholder={t("agent.skillManager.shortDescriptionPlaceholder")} />
                        </Form.Item>
                    </Form>
                </>
            )}
        </Modal>
    );
}
