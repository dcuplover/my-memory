import { Database, Connection } from "kuzu";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 作用域连接：打开 → 执行回调 → 关闭。
 * 确保每次操作完成后立即释放文件锁，避免多进程冲突。
 * 若打开时遇到锁冲突，自动重试（指数退避）。
 */
export async function withGraphConnection<T>(
    dbPath: string,
    fn: (conn: InstanceType<typeof Connection>) => Promise<T>,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let db: InstanceType<typeof Database> | null = null;
        let conn: InstanceType<typeof Connection> | null = null;
        try {
            // bufferPoolSize 256MB, enableCompression, readOnly=false, maxDBSize 1GB
            db = new Database(dbPath, 256 * 1024 * 1024, true, false, 1024 * 1024 * 1024);
            conn = new Connection(db);
            return await fn(conn);
        } catch (err) {
            lastError = err;
            const msg = String(err).toLowerCase();
            const isLockError = msg.includes("lock") || msg.includes("busy") || msg.includes("access");
            if (!isLockError || attempt >= MAX_RETRIES) throw err;
            console.warn(`[图谱] DB 锁冲突，${RETRY_BASE_MS * (attempt + 1)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
            await sleep(RETRY_BASE_MS * (attempt + 1));
        } finally {
            try { conn?.close(); } catch {}
            try { await db?.close(); } catch {}
        }
    }
    throw lastError;
}
