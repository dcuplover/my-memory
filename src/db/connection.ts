import { connect } from "@lancedb/lancedb";
import type { LanceDbConnection } from "@lancedb/lancedb";

const _connectionCache = new Map<string, LanceDbConnection>();

export async function getConnection(dbPath: string): Promise<LanceDbConnection> {
    const cached = _connectionCache.get(dbPath);
    if (cached) return cached;

    const conn = await connect(dbPath);
    _connectionCache.set(dbPath, conn);
    return conn;
}
