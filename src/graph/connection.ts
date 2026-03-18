import { Database, Connection } from "kuzu";
import * as fs from "fs";
import * as path from "path";

let _db: InstanceType<typeof Database> | null = null;
let _conn: InstanceType<typeof Connection> | null = null;
let _dbPath: string | null = null;

function tryRemoveLockFile(dbPath: string): boolean {
    const lockFile = path.join(dbPath, ".lock");
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            return true;
        }
    } catch {}
    return false;
}

export async function getGraphConnection(dbPath: string): Promise<InstanceType<typeof Connection>> {
    if (_conn && _dbPath === dbPath) return _conn;
    await closeGraphConnection();
    // bufferPoolSize 256MB, maxDBSize 1GB — 避免 Kuzu 默认 8TB mmap 在树莓派等设备上失败
    try {
        _db = new Database(dbPath, 256 * 1024 * 1024, 1024 * 1024 * 1024);
    } catch (err: any) {
        // 锁文件残留（进程崩溃后未释放），自动清理后重试一次
        if (err?.message?.includes("Could not set lock on file") && tryRemoveLockFile(dbPath)) {
            _db = new Database(dbPath, 256 * 1024 * 1024, 1024 * 1024 * 1024);
        } else {
            throw err;
        }
    }
    _conn = new Connection(_db);
    _dbPath = dbPath;
    return _conn;
}

export async function closeGraphConnection(): Promise<void> {
    if (_conn) { try { _conn.close(); } catch {} }
    if (_db) { try { await _db.close(); } catch {} }
    _conn = null;
    _db = null;
    _dbPath = null;
}
