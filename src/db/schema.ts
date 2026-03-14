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
        evidence: 1,
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
        extracted: false,
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
    [TABLE_NAMES.WATCH_STATE]: (d) => ({
        id: "__seed__",
        filePath: "",
        type: "",
        mtimeMs: 0,
        size: 0,
        processedAt: "",
        status: "",
        vector: makeVector(d),
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

// ─── Track which tables have had FTS indexes ensured this session ───

const ftsEnsured = new Set<string>();
const migrationChecked = new Set<string>();

// ─── Schema migration: detect missing columns and rebuild table ───

/**
 * Convert a LanceDB vector result (Float32Array / object with metadata) back to plain number[].
 */
function toPlainVector(v: unknown, dims: number): number[] {
    if (!v) return new Array(dims).fill(0);
    if (Array.isArray(v)) return v;
    // Float32Array or similar typed array
    if (typeof v === "object" && "length" in (v as any)) {
        return Array.from(v as ArrayLike<number>);
    }
    return new Array(dims).fill(0);
}

async function migrateTableIfNeeded(
    conn: LanceDbConnection,
    table: LanceDbTable,
    tableName: string,
    dims: number,
): Promise<LanceDbTable> {
    const cacheKey = `${tableName}`;
    if (migrationChecked.has(cacheKey)) return table;

    const seedFn = SCHEMA_SEEDS[tableName];
    if (!seedFn) return table;

    const seedRow = seedFn(dims);
    const seedKeys = new Set(Object.keys(seedRow));

    // Try adding the seed row — if schema is up-to-date, it will succeed
    try {
        await table.add([seedRow]);
        await table.delete(`id = '__seed__'`);
        migrationChecked.add(cacheKey);
        return table;
    } catch (err) {
        const msg = String(err);
        if (!msg.includes("not in schema")) {
            // Different error — skip migration
            migrationChecked.add(cacheKey);
            return table;
        }
    }

    // Schema mismatch detected — migrate
    // 1. Read all existing rows
    const zeroVec = new Array(dims).fill(0);
    let existingRows: LanceDbRow[];
    try {
        existingRows = await table.search(zeroVec).limit(100000).toArray();
    } catch {
        existingRows = [];
    }

    // 2. Drop old table
    try {
        await conn.dropTable(tableName);
    } catch {
        // Table may already have been dropped by a concurrent call
    }

    // 3. Create new table with full schema
    let newTable: LanceDbTable;
    try {
        newTable = await conn.createTable(tableName, [seedRow]);
    } catch {
        // Table might have been recreated by a concurrent call
        newTable = await conn.openTable(tableName);
        migrationChecked.add(cacheKey);
        return newTable;
    }

    try {
        await newTable.delete(`id = '__seed__'`);
    } catch { /* non-critical */ }

    // 4. Re-insert old rows: only copy seed-defined fields, convert vectors
    if (existingRows.length > 0) {
        const migratedRows = existingRows.map((row) => {
            const migrated: LanceDbRow = {};
            for (const key of seedKeys) {
                if (key === "vector") {
                    migrated[key] = toPlainVector(row[key], dims);
                } else if (key in row) {
                    migrated[key] = row[key];
                } else {
                    migrated[key] = seedRow[key];
                }
            }
            return migrated;
        });
        await newTable.add(migratedRows);
    }

    // Clear FTS cache so indexes are rebuilt
    for (const key of ftsEnsured) {
        if (key.endsWith(`::${tableName}`)) ftsEnsured.delete(key);
    }

    migrationChecked.add(cacheKey);
    return newTable;
}

// ─── Ensure table exists ───

export async function ensureTable(
    dbPath: string,
    tableName: string,
    dims: number = DEFAULT_EMBED_DIMENSIONS,
): Promise<LanceDbTable> {
    const conn = await getConnection(dbPath);
    const existing = await conn.tableNames();

    let table: LanceDbTable;

    if (existing.includes(tableName)) {
        try {
            table = await conn.openTable(tableName);
            // Check for schema migration (new columns added since table creation)
            table = await migrateTableIfNeeded(conn, table, tableName, dims);
            // Quick health check: verify data files are intact
            const zeroVec = new Array(dims).fill(0);
            await table.search(zeroVec).limit(1).toArray();
        } catch (err) {
            const msg = String(err);
            if (msg.includes("Not found") || msg.includes("LanceError") || msg.includes("corrupt")) {
                // Data files corrupted / missing — drop and recreate
                try { await conn.dropTable(tableName); } catch { /* already gone */ }
                const seedFn = SCHEMA_SEEDS[tableName];
                if (!seedFn) throw new Error(`Unknown table: ${tableName}`);
                table = await conn.createTable(tableName, [seedFn(dims)]);
                try { await table.delete(`id = '__seed__'`); } catch { /* non-critical */ }
                // Clear caches so FTS/migration are re-checked
                migrationChecked.delete(tableName);
                for (const key of ftsEnsured) {
                    if (key.endsWith(`::${tableName}`)) ftsEnsured.delete(key);
                }
            } else {
                throw err;
            }
        }
    } else {
        const seedFn = SCHEMA_SEEDS[tableName];
        if (!seedFn) {
            throw new Error(`Unknown table: ${tableName}`);
        }

        table = await conn.createTable(tableName, [seedFn(dims)]);

        // Remove seed row
        try {
            await table.delete(`id = '__seed__'`);
        } catch {
            // Seed cleanup non-critical
        }
    }

    // Ensure FTS indexes exist (once per session per table)
    const cacheKey = `${dbPath}::${tableName}`;
    if (!ftsEnsured.has(cacheKey)) {
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
        ftsEnsured.add(cacheKey);
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
