import { Database, Connection } from "kuzu";

/**
 * 作用域连接：打开 → 执行回调 → 关闭。
 * 确保每次操作完成后立即释放文件锁，避免多进程冲突。
 */
export async function withGraphConnection<T>(
    dbPath: string,
    fn: (conn: InstanceType<typeof Connection>) => Promise<T>,
): Promise<T> {
    // bufferPoolSize 256MB, enableCompression, readOnly=false, maxDBSize 1GB
    const db = new Database(dbPath, 256 * 1024 * 1024, true, false, 1024 * 1024 * 1024);
    const conn = new Connection(db);
    try {
        return await fn(conn);
    } finally {
        try { conn.close(); } catch {}
        try { await db.close(); } catch {}
    }
}
