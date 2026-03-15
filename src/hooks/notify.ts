import type { HooksConfig } from "../config";

/**
 * 通过 OpenClaw Webhook `/hooks/agent` 发送可见通知。
 * deliver=true 确保 agent 将消息转达给用户（可见消息）。
 *
 * 与 /hooks/wake（只注入系统事件，用户不可见）不同，
 * /hooks/agent 会运行一次 agent round 并将结果发给用户。
 */
export async function notifyViaHooks(
    hooks: HooksConfig,
    text: string,
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
): Promise<void> {
    const url = `${hooks.baseUrl.replace(/\/+$/, "")}/hooks/agent`;
    const payload = {
        message: `请将以下插件任务结果原样转告用户（不要修改内容）：\n\n${text}`,
        deliver: true,
    };
    try {
        logger?.info?.(`[hooks/agent] 发送通知: ${text.slice(0, 200)}`);
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${hooks.token}`,
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            logger?.warn?.(`[hooks/agent] HTTP ${res.status}: ${body}`);
        } else {
            logger?.info?.(`[hooks/agent] 通知已接受 (202)`);
        }
    } catch (err) {
        logger?.warn?.(`[hooks/agent] 请求失败: ${String(err)}`);
    }
}
