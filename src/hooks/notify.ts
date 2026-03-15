import type { HooksConfig } from "../config";

/**
 * 通过 OpenClaw Webhook `/hooks/wake` 发送系统事件通知。
 * mode=now 会立即触发心跳，让用户尽快看到消息。
 */
export async function notifyViaWake(
    hooks: HooksConfig,
    text: string,
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
): Promise<void> {
    const url = `${hooks.baseUrl.replace(/\/+$/, "")}/hooks/wake`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${hooks.token}`,
            },
            body: JSON.stringify({ text, mode: "now" }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            logger?.warn?.(`[hooks/wake] HTTP ${res.status}: ${body}`);
        } else {
            logger?.info?.(`[hooks/wake] 通知已发送`);
        }
    } catch (err) {
        logger?.warn?.(`[hooks/wake] 请求失败: ${String(err)}`);
    }
}
