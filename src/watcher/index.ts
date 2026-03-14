import { watch, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, extname, basename, join } from "path";
import { addDiary } from "../document/diary";
import { addDocument } from "../document/file";
import { extractMemoryFromDiary, extractMemoryFromDocument } from "../memory/extract_from_source";
import { ensureTable } from "../db/schema";
import { TABLE_NAMES, getLanceDbPath, type WatchPathConfig } from "../config";

// ─── Types ───

type PathWatcher = {
    config: WatchPathConfig;
    close: () => void;
    scheduledTimer?: ReturnType<typeof setInterval>;
};

type PendingFile = {
    filePath: string;
    timer: ReturnType<typeof setTimeout>;
};

// ─── File Watcher Service ───

export class FileWatcherService {
    private api: any;
    private watchers: Map<string, PathWatcher> = new Map();
    private pendingFiles: Map<string, PendingFile> = new Map();
    private processing: Set<string> = new Set();
    private stopped = false;

    constructor(api: any) {
        this.api = api;
    }

    /**
     * 启动所有已配置路径的监听
     */
    start(configs: WatchPathConfig[]): void {
        this.stopped = false;
        for (const config of configs) {
            this.watchPath(config);
        }
        this.log(`文件监听服务已启动，监听 ${configs.length} 个路径`);
    }

    /**
     * 停止所有监听
     */
    stop(): void {
        this.stopped = true;
        for (const [, watcher] of this.watchers) {
            watcher.close();
            if (watcher.scheduledTimer) clearInterval(watcher.scheduledTimer);
        }
        for (const [, pending] of this.pendingFiles) {
            clearTimeout(pending.timer);
        }
        this.watchers.clear();
        this.pendingFiles.clear();
        this.log("文件监听服务已停止");
    }

    /**
     * 获取运行状态
     */
    getStatus(): { watching: number; paths: string[] } {
        return {
            watching: this.watchers.size,
            paths: Array.from(this.watchers.keys()),
        };
    }

    // ─── 持久化状态查询/更新 ───

    private async getFileState(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
        const dbPath = getLanceDbPath(this.api);
        if (!dbPath) return null;
        try {
            const table = await ensureTable(dbPath, TABLE_NAMES.WATCH_STATE);
            const rows = await table.search("").where(`filePath = '${filePath.replace(/'/g, "''")}'`).limit(1).toArray();
            if (rows.length === 0) return null;
            return { mtimeMs: Number(rows[0].mtimeMs ?? 0), size: Number(rows[0].size ?? 0) };
        } catch {
            return null;
        }
    }

    private async saveFileState(filePath: string, type: string, mtimeMs: number, size: number): Promise<void> {
        const dbPath = getLanceDbPath(this.api);
        if (!dbPath) return;
        try {
            const table = await ensureTable(dbPath, TABLE_NAMES.WATCH_STATE);
            const escapedPath = filePath.replace(/'/g, "''");
            const existing = await table.search("").where(`filePath = '${escapedPath}'`).limit(1).toArray();
            const now = new Date().toISOString();

            if (existing.length > 0) {
                await table.update({
                    where: `filePath = '${escapedPath}'`,
                    values: { mtimeMs, size, processedAt: now, status: "processed" },
                });
            } else {
                const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                await table.add([{ id, filePath, type, mtimeMs, size, processedAt: now, status: "processed" }]);
            }
        } catch (err) {
            this.log(`保存文件状态失败 ${filePath}: ${String(err)}`);
        }
    }

    /**
     * 检查文件是否已变化（与持久化状态对比）
     */
    private async hasFileChanged(filePath: string): Promise<boolean> {
        try {
            const stat = statSync(filePath);
            const saved = await this.getFileState(filePath);
            if (!saved) return true; // 新文件
            return stat.mtimeMs > saved.mtimeMs || stat.size !== saved.size;
        } catch {
            return false;
        }
    }

    // ─── Private ───

    private watchPath(config: WatchPathConfig): void {
        const watchDir = resolve(config.path);

        if (!existsSync(watchDir)) {
            this.log(`路径不存在，跳过: ${watchDir}`);
            return;
        }

        if (config.trigger === "scheduled") {
            // 定时扫描模式
            const intervalMs = (config.intervalMinutes ?? 60) * 60 * 1000;
            const timer = setInterval(() => {
                if (!this.stopped) this.scanDirectory(watchDir, config);
            }, intervalMs);

            this.watchers.set(watchDir, {
                config,
                close: () => {},
                scheduledTimer: timer,
            });

            this.log(`[scheduled] 监听 ${watchDir}，间隔 ${config.intervalMinutes ?? 60} 分钟`);
        } else {
            // immediate 或 debounce 模式
            const debounceMs = config.trigger === "debounce" ? (config.debounceSeconds ?? 30) * 1000 : 500;

            try {
                const fsWatcher = watch(watchDir, { recursive: true }, (eventType, filename) => {
                    if (this.stopped || !filename) return;
                    const filePath = resolve(watchDir, filename);
                    if (!this.isTargetFile(filePath, config)) return;
                    this.handleFileChange(filePath, config, debounceMs);
                });

                this.watchers.set(watchDir, {
                    config,
                    close: () => fsWatcher.close(),
                });

                this.log(`[${config.trigger ?? "debounce"}] 监听 ${watchDir}，类型=${config.type}，后缀=${(config.extensions ?? [".md", ".txt"]).join(",")}`);
            } catch (err) {
                this.log(`监听失败 ${watchDir}: ${String(err)}`);
            }
        }
    }

    /**
     * 递归列出目录下所有符合条件的文件
     */
    private listFiles(dir: string, config: WatchPathConfig): string[] {
        const result: string[] = [];
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    result.push(...this.listFiles(fullPath, config));
                } else if (this.isTargetFile(fullPath, config)) {
                    result.push(fullPath);
                }
            }
        } catch { /* ignore */ }
        return result;
    }

    /**
     * 检查文件是否为目标类型
     */
    private isTargetFile(filePath: string, config: WatchPathConfig): boolean {
        const ext = extname(filePath).toLowerCase();
        const allowed = config.extensions ?? [".md", ".txt"];
        return allowed.includes(ext);
    }

    /**
     * 处理文件变更（debounce）
     */
    private handleFileChange(filePath: string, config: WatchPathConfig, debounceMs: number): void {
        // 取消之前的 pending
        const existing = this.pendingFiles.get(filePath);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            this.pendingFiles.delete(filePath);
            this.processFile(filePath, config);
        }, debounceMs);

        this.pendingFiles.set(filePath, { filePath, timer });
    }

    /**
     * 定时扫描目录，找到新增/变更文件
     */
    private async scanDirectory(dir: string, config: WatchPathConfig): Promise<void> {
        const files = this.listFiles(dir, config);
        for (const filePath of files) {
            const changed = await this.hasFileChanged(filePath);
            if (changed) {
                await this.processFile(filePath, config);
            }
        }
    }

    /**
     * 处理单个文件：对比状态 → 读取 → 存储 → 提取记忆 → 更新状态
     */
    private async processFile(filePath: string, config: WatchPathConfig): Promise<void> {
        if (this.processing.has(filePath)) return;
        if (!existsSync(filePath)) return;

        // 对比持久化状态，未变化则跳过
        const changed = await this.hasFileChanged(filePath);
        if (!changed) return;

        this.processing.add(filePath);
        const fileName = basename(filePath);

        try {
            const content = readFileSync(filePath, "utf-8");
            if (!content.trim()) return;

            const stat = statSync(filePath);
            this.log(`处理文件: ${filePath} (类型=${config.type}, mtime=${new Date(stat.mtimeMs).toISOString()})`);

            if (config.type === "diary") {
                const date = this.extractDate(fileName);
                const { chunksAdded } = await addDiary(this.api, content, fileName, date, "diary");
                this.log(`日记已存储: ${fileName}，${chunksAdded} 个切片`);

                if (config.autoExtract !== false) {
                    const result = await extractMemoryFromDiary(this.api, { date, force: false });
                    this.log(`日记记忆提取: +${result.totalAdded} ~${result.totalUpdated} -${result.totalDeleted}`);
                }
            } else {
                const { summary } = await addDocument(this.api, content, filePath, fileName);
                this.log(`文档已存储: ${fileName}，摘要长度=${summary.length}`);

                if (config.autoExtract !== false) {
                    const result = await extractMemoryFromDocument(this.api, { content });
                    this.log(`文档记忆提取: +${result.totalAdded} ~${result.totalUpdated} -${result.totalDeleted}`);
                }
            }

            // 处理成功后更新持久化状态
            await this.saveFileState(filePath, config.type, stat.mtimeMs, stat.size);
        } catch (err) {
            this.log(`处理文件失败 ${filePath}: ${String(err)}`);
        } finally {
            this.processing.delete(filePath);
        }
    }

    /**
     * 从文件名中尝试提取日期（YYYY-MM-DD），兜底为当天
     */
    private extractDate(fileName: string): string {
        const match = fileName.match(/(\d{4}[-_]?\d{2}[-_]?\d{2})/);
        if (match) {
            const raw = match[1].replace(/_/g, "-");
            // 如果是 YYYYMMDD 格式，补齐连字符
            if (raw.length === 8 && !raw.includes("-")) {
                return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
            }
            return raw;
        }
        return new Date().toISOString().slice(0, 10);
    }

    private log(msg: string): void {
        this.api.logger?.info?.(`[FileWatcher] ${msg}`);
    }
}
