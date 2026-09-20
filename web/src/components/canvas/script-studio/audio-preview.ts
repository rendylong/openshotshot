/** studio 级音频试听单例（spec D14）：同源再点 = 停止、后播停前播；
    chip 移除/行删除/组件卸载时按源 stop，禁止「chip 已消失、声音还在放」。 */
type Listener = (state: { url: string | null }) => void;
let current: { url: string; audio: HTMLAudioElement } | null = null;
const listeners = new Set<Listener>();

function notify() {
    const state = { url: current?.url ?? null };
    listeners.forEach((listener) => listener(state));
}

export function subscribeAudioPreview(listener: Listener): () => void {
    listeners.add(listener);
    listener({ url: current?.url ?? null });
    return () => listeners.delete(listener);
}

export function stopAudioPreview(url?: string) {
    if (!current) return;
    if (url && current.url !== url) return;
    current.audio.pause();
    current = null;
    notify();
}

export function playAudioPreview(url: string, onError?: () => void) {
    if (current?.url === url) {
        stopAudioPreview();
        return;
    }
    stopAudioPreview();
    const audio = new Audio(url);
    audio.onerror = () => {
        if (current?.audio !== audio) return;
        current = null;
        notify();
        onError?.();
    };
    audio.onended = () => {
        if (current?.audio !== audio) return;
        current = null;
        notify();
    };
    current = { url, audio };
    notify();
    void audio.play().catch(() => {
        if (current?.audio !== audio) return;
        current = null;
        notify();
        onError?.();
    });
}
