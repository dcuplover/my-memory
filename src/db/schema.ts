import type { LanceDbRow, LanceDbTable, LanceDbConnection } from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { getConnection } from "./connection";
import {
    TABLE_NAMES,
    DEFAULT_EMBED_DIMENSIONS,
    DEFAULT_MEMORY_FTS_COLUMNS,
    DEFAULT_DIARY_FTS_COLUMNS,
    DEFAULT_DOCUMENT_FTS_COLUMNS,
} from "../config";

// ─── Schema seed rows (one dummy row per table to define schema on creation) ───

function makeVector(dims: number): number[] {
    return new Array(dims).fill(0);
}

function memoryBaseSeed(dims: number): LanceDbRow {
    return {
        id: "__seed__",
        content: "",
        subject: "",
        vector: makeVector(dims),
        channel: "",
        credibility: 0,
        createdAt: "",
        updatedAt: "",
    };
}

const SCHEMA_SEEDS: Record<string, (dims: number) => LanceDbRow> = {
    [TABLE_NAMES.ATTITUDE]: (d) => ({ ...memoryBaseSeed(d), attitude: "" }),
    [TABLE_NAMES.FACT]: (d) => ({ ...memoryBaseSeed(d), definition: "" }),
    [TABLE_NAMES.KNOWLEDGE]: (d) => ({ ...memoryBaseSeed(d), scenario: "", action: "" }),
    [TABLE_NAMES.PREFERENCE]: (d) => ({ ...memoryBaseSeed(d), scenario: "", options: "", preferred: "" }),
    [TABLE_NAMES.DIARY]: (d) => ({
        id: "__seed__",
        content: "",
        title: "",
        date: "",
        chunk_index: 0,
        source_id: "",
        vector: makeVector(d),
        channel: "",
        credibility: 0,
        createdAt: "",
    }),
    [TABLE_NAMES.DOCUMENT]: (d) => ({
        id: "__seed__",
        summary: "",
        title: "",
        file_path: "",
        doc_type: "",
        vector: makeVector(d),
        channel: "",
        credibility: 0,
        createdAt: "",
    }),
};

// ─── FTS columns per table ───

const FTS_COLUMNS_MAP: Record<string, string[]> = {
    [TABLE_NAMES.ATTITUDE]: DEFAULT_MEMORY_FTS_COLUMNS,
    [TABLE_NAMES.FACT]: DEFAULT_MEMORY_FTS_COLUMNS,
    [TABLE_NAMES.KNOWLEDGE]: ["content", "scenario"],
    [TABLE_NAMES.PREFERENCE]: ["content", "scenario"],
    [TABLE_NAMES.DIARY]: DEFAULT_DIARY_FTS_COLUMNS,
    [TABLE_NAMES.DOCUMENT]: DEFAULT_DOCUMENT_FTS_COLUMNS,
};

// ─── Ensure table exists ───

export async function ensureTable(
    dbPath: string,
    tableName: string,
    dims: number = DEFAULT_EMBED_DIMENSIONS,
): Promise<LanceDbTable> {
    const conn = await getConnection(dbPath);
    const existing = await conn.tableNames();

    if (existing.includes(tableName)) {
        return conn.openTable(tableName);
    }

    const seedFn = SCHEMA_SEEDS[tableName];
    if (!seedFn) {
        throw new Error(`Unknown table: ${tableName}`);
    }

    const table = await conn.createTable(tableName, [seedFn(dims)]);

    // Create FTS index
    const ftsColumns = FTS_COLUMNS_MAP[tableName];
    if (ftsColumns) {
        for (const col of ftsColumns) {
            try {
                await table.createIndex(col, { config: { inner: Index.fts() }, replace: true });
            } catch {
                // FTS index creation may fail silently on some columns; non-blocking
            }
        }
    }

    // Remove seed row
    try {
        await table.delete(`id = '__seed__'`);
    } catch {
        // Seed cleanup non-critical
    }

    return table;
}

// ─── Ensure all tables ───

export async function ensureAllTables(
    dbPath: string,
    dims: number = DEFAULT_EMBED_DIMENSIONS,
): Promise<void> {
    const allTables = Object.values(TABLE_NAMES);
    for (const tableName of allTables) {
        await ensureTable(dbPath, tableName, dims);
    }
}

// ─── Get table (assumes exists) ───

export async function getTable(dbPath: string, tableName: string): Promise<LanceDbTable> {
    const conn = await getConnection(dbPath);
    return conn.openTable(tableName);
}

export function getFtsColumns(tableName: string): string[] {
    return FTS_COLUMNS_MAP[tableName] ?? DEFAULT_MEMORY_FTS_COLUMNS;
}
