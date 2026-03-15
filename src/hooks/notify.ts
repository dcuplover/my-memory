import type { HooksConfig } from "../config";

/**
 * 通过 OpenClaw Webhook `/hooks/wake` 发送系统事件通知。
 * mode=now 触发即时心跳，文本注入系统上下文，用户下次交互时 AI 可见。
 *
 * 选择 wake 而非 agent 的原因：
 * - /hooks/agent 需要运行 agent round（依赖 LLM），当 LLM 故障时通知也会失败
 * - /hooks/wake 是轻量级系统事件注入，不依赖 LLM，可靠性更高
 */
export async function notifyViaHooks(
    hooks: HooksConfig,
    text: string,
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
): Promise<void> {
    const baseUrl = hooks.baseUrl.replace(/\/+$/, "");

    // 使用 /hooks/wake 注入系统事件（轻量，不依赖 LLM）
    const wakeUrl = `${baseUrl}/hooks/wake`;
    try {
        logger?.info?.(`[hooks/wake] 发送通知: ${text.slice(0, 200)}`);
        const res = await fetch(wakeUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${hooks.token}`,
            },
            body: JSON.stringify({ text: `[my-memory 插件通知] ${text}`, mode: "now" }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            logger?.warn?.(`[hooks/wake] HTTP ${res.status}: ${body}`);
        } else {
            logger?.info?.(`[hooks/wake] 通知已发送 (200)`);
        }
    } catch (err) {
        logger?.warn?.(`[hooks/wake] 请求失败: ${String(err)}`);
    }
}
