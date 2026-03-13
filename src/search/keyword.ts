import type { LanceDbRow } from "@lancedb/lancedb";
import { ensureTable, getFtsColumns } from "../db/schema";

// ─── Keyword / FTS search (BM25) ───

export async function keywordSearch(
    dbPath: string,
    tableName: string,
    query: string,
    limit: number,
    ftsColumns?: string[],
): Promise<LanceDbRow[]> {
    const table = await ensureTable(dbPath, tableName);
    const columns = ftsColumns ?? getFtsColumns(tableName);
    const rows = await table.search(query, "fts", columns).limit(limit).toArray();
    return Array.isArray(rows) ? rows : [];
}
