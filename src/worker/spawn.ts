/**
 * spawn.ts — 将提取任务派发到独立进程
 *
 * 流程：
 * 1. 从 api 读取所有配置，序列化为 task JSON
 * 2. 写入临时文件 /tmp/my-memory/extract-task-{id}.json
 * 3. spawn("npx", ["tsx", "extract-runner.ts", taskPath]) detached
 * 4. 立即返回 taskId
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import {
    getPluginConfig,
    getNotifyConfig,
    type NotifyConfig,
} from "../config";

// ─── 任务目录 ───

function getTaskDir(): string {
    const dir = join(tmpdir(), "my-memory-tasks");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ─── 生成 task ID ───

function generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Worker 脚本路径 ───

function getWorkerPath(): string {
    // __dirname 在 OpenClaw TS 加载器中指向当前文件所在目录
    // extract-runner.ts 在同目录下
    return resolve(__dirname, "extract-runner.ts");
}

// ─── 公共接口 ───

export type SpawnExtractOptions = {
    type: "diary" | "document";
    options: Record<string, unknown>;
};

export type SpawnResult = {
    taskId: string;
    taskPath: string;
};

/**
 * 将提取任务派发到独立进程。
 * 序列化当前 api 配置 → 写 task JSON → spawn detached worker。
 */
export function spawnExtractWorker(api: any, opts: SpawnExtractOptions): SpawnResult {
    const taskId = generateTaskId();
    const taskDir = getTaskDir();
    const taskPath = join(taskDir, `${taskId}.json`);

    // 读取插件完整配置（传给 worker 的 mock api）
    const pluginConfig = getPluginConfig(api);
    const notify = getNotifyConfig(api);

    const task = {
        taskId,
        type: opts.type,
        pluginConfig,
        options: opts.options,
        notify,
    };

    // 写入 task 文件
    writeFileSync(taskPath, JSON.stringify(task, null, 2), "utf-8");

    // 启动独立进程
    const workerPath = getWorkerPath();
    const child = spawn("npx", ["tsx", workerPath, taskPath], {
        cwd: resolve(__dirname, "../.."),  // 插件根目录，确保 node_modules 可用
        detached: true,
        stdio: "ignore",   // 完全脱离主进程 IO
    });

    // 让子进程脱离父进程（主进程退出不影响子进程）
    child.unref();

    const logger = api.logger;
    logger?.info?.(`[spawn] 提取任务已派发: ${taskId} (type=${opts.type}, pid=${child.pid})`);
    logger?.info?.(`[spawn] task file: ${taskPath}`);
    logger?.info?.(`[spawn] worker: npx tsx ${workerPath}`);

    return { taskId, taskPath };
}
