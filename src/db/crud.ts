import type { LanceDbRow } from "@lancedb/lancedb";
import { ensureTable, getTable } from "./schema";
import { DEFAULT_EMBED_DIMENSIONS } from "../config";

// ─── Add records ───

export async function addRecords(
    dbPath: string,
    tableName: string,
    records: LanceDbRow[],
    dims?: number,
): Promise<void> {
    if (records.length === 0) return;
    const table = await ensureTable(dbPath, tableName, dims);
    await table.add(records);
}

// ─── Get record by ID ───

export async function getRecordById(
    dbPath: string,
    tableName: string,
    id: string,
): Promise<LanceDbRow | undefined> {
    const table = await getTable(dbPath, tableName);
    const zeroVec = new Array(DEFAULT_EMBED_DIMENSIONS).fill(0);
    const rows = await table.search(zeroVec).where(`id = '${escapeSql(id)}'`).limit(1).toArray();
    return rows[0];
}

// ─── Update record ───

export async function updateRecord(
    dbPath: string,
    tableName: string,
    id: string,
    values: Record<string, unknown>,
): Promise<void> {
    const table = await getTable(dbPath, tableName);
    await table.update({
        where: `id = '${escapeSql(id)}'`,
        values,
    });
}

// ─── Delete record ───

export async function deleteRecord(
    dbPath: string,
    tableName: string,
    id: string,
): Promise<void> {
    const table = await getTable(dbPath, tableName);
    await table.delete(`id = '${escapeSql(id)}'`);
}

// ─── Count rows ───

export async function countRows(
    dbPath: string,
    tableName: string,
): Promise<number> {
    const table = await getTable(dbPath, tableName);
    return table.countRows();
}

// ─── SQL escape helper (prevent injection) ───

function escapeSql(value: string): string {
    return value.replace(/'/g, "''");
}
