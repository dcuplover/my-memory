import { Database, Connection } from "kuzu";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * KùzuDB v0.11.x Node 绑定的原生析构函数（Connection/Database）会触发 SIGSEGV，
 * 包括显式 close() 和 GC 回收时的 Release callback 均会崩溃。
 *
 * 策略：
 * - _keepAlive: 持有所有曾创建的原生对象引用，阻止 GC 回收触发析构
 * - _pool: 按 dbPath 缓存活跃连接，避免重复 open（也减少文件锁竞争）
 * - 进程退出时由 OS 统一回收，不存在泄漏
 */
const _keepAlive: unknown[] = [];
const _pool = new Map<string, InstanceType<typeof Connection>>();

/**
 * 作用域连接：复用缓存连接执行回调。
 * 若遇到锁冲突，丢弃旧连接（引用仍在 _keepAlive 中，不会被 GC）→ 等待 → 重建。
 */
export async function withGraphConnection<T>(
    dbPath: string,
    fn: (conn: InstanceType<typeof Connection>) => Promise<T>,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            let conn = _pool.get(dbPath);
            if (!conn) {
                const db = new Database(dbPath, 256 * 1024 * 1024, true, false, 1024 * 1024 * 1024);
                conn = new Connection(db);
                _keepAlive.push(db, conn);
                _pool.set(dbPath, conn);
            }
            return await fn(conn);
        } catch (err) {
            lastError = err;
            const msg = String(err).toLowerCase();
            const isLockError = msg.includes("lock") || msg.includes("busy") || msg.includes("access");
            if (!isLockError || attempt >= MAX_RETRIES) throw err;
            // 锁冲突：从池中移除（引用仍在 _keepAlive，不会被 GC），等待后重建
            _pool.delete(dbPath);
            console.warn(`[图谱] DB 锁冲突，${RETRY_BASE_MS * (attempt + 1)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
            await sleep(RETRY_BASE_MS * (attempt + 1));
        }
    }
    throw lastError;
}
