import type { LanceDbRow } from "@lancedb/lancedb";
import { getTable, getFtsColumns } from "../db/schema";
import { generateEmbedding, type EmbedConfig } from "../embedding";

// ─── Vector search ───

export async function vectorSearch(
    dbPath: string,
    tableName: string,
    query: string,
    embedCfg: EmbedConfig,
    limit: number,
): Promise<LanceDbRow[]> {
    const vector = await generateEmbedding(query, embedCfg);
    const table = await getTable(dbPath, tableName);
    const rows = await table.search(vector).limit(limit).toArray();
    return Array.isArray(rows) ? rows : [];
}
