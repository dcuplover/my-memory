/**
 * extract-runner.ts — 独立进程 worker
 *
 * 运行方式: npx tsx src/worker/extract-runner.ts <task-json-path>
 *
 * 从 task JSON 文件读取所有配置和参数，在独立 V8 堆中执行提取，
 * 完成后通过 `openclaw message send` CLI 通知结果，然后退出。
 */
import { readFileSync } from "fs";
import { extractMemoryFromDiary, extractMemoryFromDocument } from "../memory/extract_from_source";
import type { NotifyConfig } from "../config";
import { execSync } from "child_process";

// ─── Task JSON 结构 ───

type TaskConfig = {
    taskId: string;
    type: "diary" | "document";
    /** 模拟 api 对象所需的插件配置 */
    pluginConfig: Record<string, unknown>;
    /** 提取参数 */
    options: Record<string, unknown>;
    /** 通知配置 */
    notify?: NotifyConfig;
    /** 可选：hooks 配置（保留向后兼容） */
    hooks?: { baseUrl: string; token: string };
};

// ─── 伪造 api 对象 ───
// Worker 不在 OpenClaw 进程内，需要用 task JSON 中的配置模拟 api

function createMockApi(pluginConfig: Record<string, unknown>): any {
    return {
        config: {
            plugins: {
                entries: {
                    "my-memory": { config: pluginConfig },
                },
            },
        },
        logger: {
            info: (...args: any[]) => console.log("[worker]", ...args),
            warn: (...args: any[]) => console.warn("[worker]", ...args),
            error: (...args: any[]) => console.error("[worker]", ...args),
        },
    };
}

// ─── 通知 ───

function sendNotification(notify: NotifyConfig | undefined, message: string): void {
    if (!notify) {
        console.log("[worker] 无通知配置，仅输出:", message);
        return;
    }
    try {
        const safeMsg = message.replace(/"/g, '\\"');
        const accountFlag = notify.account ? ` --account "${notify.account}"` : "";
        const cmd = `openclaw message send --channel "${notify.channel}" --target "${notify.target}"${accountFlag} --message "${safeMsg}"`;
        console.log("[worker] 执行通知:", cmd);
        execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
        console.log("[worker] 通知已发送");
    } catch (err) {
        console.error("[worker] 通知发送失败:", String(err));
    }
}

// ─── 主流程 ───

async function main(): Promise<void> {
    const taskPath = process.argv[2];
    if (!taskPath) {
        console.error("Usage: npx tsx src/worker/extract-runner.ts <task-json-path>");
        process.exit(1);
    }

    let task: TaskConfig;
    try {
        task = JSON.parse(readFileSync(taskPath, "utf-8"));
    } catch (err) {
        console.error(`[worker] 读取 task 文件失败: ${String(err)}`);
        process.exit(1);
    }

    console.log(`[worker] 任务启动: ${task.taskId} (${task.type})`);
    const api = createMockApi(task.pluginConfig);
    const startTime = Date.now();

    try {
        let resultText: string;

        if (task.type === "diary") {
            const result = await extractMemoryFromDiary(api, task.options as any);
            resultText = `✅ 日记记忆提取完成 (${task.taskId})\n` +
                `+${result.totalAdded} 新增 | ~${result.totalUpdated} 更新 | -${result.totalDeleted} 删除\n` +
                `耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        } else {
            const result = await extractMemoryFromDocument(api, task.options as any);
            resultText = `✅ 文档记忆提取完成 (${task.taskId})\n` +
                `+${result.totalAdded} 新增 | ~${result.totalUpdated} 更新 | -${result.totalDeleted} 删除\n` +
                `耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        }

        console.log(`[worker] ${resultText}`);
        sendNotification(task.notify, resultText);
    } catch (err) {
        const errText = `❌ 记忆提取失败 (${task.taskId}): ${String(err)}\n耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        console.error(`[worker] ${errText}`);
        sendNotification(task.notify, errText);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("[worker] 未捕获异常:", err);
    process.exit(1);
});
