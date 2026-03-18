import { Database, Connection } from "kuzu";

let _db: InstanceType<typeof Database> | null = null;
let _conn: InstanceType<typeof Connection> | null = null;
let _dbPath: string | null = null;

export async function getGraphConnection(dbPath: string): Promise<InstanceType<typeof Connection>> {
    if (_conn && _dbPath === dbPath) return _conn;
    await closeGraphConnection();
    // 指定 bufferPoolSize 256MB，避免 Kuzu 默认请求 8TB mmap 导致 OOM
    _db = new Database(dbPath, 256 * 1024 * 1024);
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
