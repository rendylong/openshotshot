import { Tag, theme as antdTheme } from "antd";

export type SkillStatus = "available" | "manual" | "invalid";

type Props = {
    status: SkillStatus;
    label: string;
    className?: string;
};

export function SkillStatusTag({ status, label, className }: Props) {
    const { token } = antdTheme.useToken();
    const dotColor = status === "invalid" ? token.colorError : status === "manual" ? token.colorWarning : token.colorSuccess;
    return (
        <Tag variant="filled" className={className} style={status === "invalid" ? { color: token.colorError } : undefined}>
            <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
                {label}
            </span>
        </Tag>
    );
}
