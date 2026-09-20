import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Space } from "antd";
import { useTranslation } from "react-i18next";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
export function ChatGptConnection() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { status } = useChatGptStore();
    const [answer, setAnswer] = useState("");
    const bridge = window.shotshot?.chatgpt;
    useEffect(() => setAnswer(""), [status.prompt?.id]);
    const run = async (action: () => Promise<void>) => { try { await action(); } catch { void message.error(t("aiSources.actionFailed")); } };
    if (!bridge) return <p className="text-sm text-muted-foreground" role="status">{t("aiSources.desktopOnly")}</p>;
    return <Space orientation="vertical" className="w-full" size="middle">
        <p className="text-sm text-muted-foreground">{t("aiSources.chatgptDescription")}</p>
        <div className="text-sm">{t(`aiSources.status.${status.state}`)}</div>
        {status.state === "error" && <Alert type="error" title={t(`aiSources.errors.${status.errorCode ?? "login_failed"}`)} />}
        {status.state === "signing-in" ? <>
            {status.deviceCode && <div className="space-y-2"><code className="block text-lg">{status.deviceCode.userCode}</code><a href={status.deviceCode.verificationUri} target="_blank" rel="noreferrer">{t("aiSources.openVerification")}</a></div>}
            {status.prompt?.type === "select" ? <Space wrap>{status.prompt.options?.map(option => <Button key={option.id} onClick={() => void run(() => bridge.respond(status.prompt!.id, option.id))}>{option.id === "browser" ? t("aiSources.browserLogin") : option.id === "device_code" ? t("aiSources.deviceLogin") : option.label}</Button>)}</Space> : status.prompt ? <Space orientation="vertical" className="w-full">
                <Input.Password aria-label={t("aiSources.authorizationCode")} placeholder={t("aiSources.authorizationCode")} value={answer} onChange={e => setAnswer(e.target.value)} autoComplete="off" />
                <Button disabled={!answer.trim()} onClick={() => { const value = answer; setAnswer(""); void run(() => bridge.respond(status.prompt!.id, value)); }}>{t("aiSources.submitCode")}</Button>
            </Space> : null}
            <Button onClick={() => void run(() => bridge.cancelSignIn())}>{t("aiSources.cancel")}</Button>
        </> : status.state === "signed-in" ? <Button onClick={() => void run(() => bridge.signOut())}>{t("aiSources.disconnect")}</Button> : <Button type="primary" onClick={() => void run(() => bridge.signIn())}>{t("aiSources.connect")}</Button>}
    </Space>;
}
