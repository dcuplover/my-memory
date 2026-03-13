import type { LanceDbRow } from "@lancedb/lancedb";
import { vectorSearch } from "./vector";
import { keywordSearch } from "./keyword";
import { rerankDocuments, type RerankConfig } from "./reranker";
import type { EmbedConfig } from "../embedding";

export type SearchMode = "hybrid" | "vector" | "keyword";

export type SearchOptions = {
    dbPath: string;
    tableName: string;
    query: string;
    mode: SearchMode;
    limit: number;
    topK: number;
    embedCfg?: EmbedConfig;
    rerankCfg?: RerankConfig;
    ftsColumns?: string[];
};

export type SearchResult = LanceDbRow & {
    _score?: number;
};

/**
 * Unified search entry point supporting three modes:
 * - "vector": pure vector search
 * - "keyword": pure BM25/FTS search
 * - "hybrid": vector + keyword, merge, optional rerank
 */
export async function search(opts: SearchOptions): Promise<SearchResult[]> {
    const { mode } = opts;

    switch (mode) {
        case "vector":
            return doVectorSearch(opts);
        case "keyword":
            return doKeywordSearch(opts);
        case "hybrid":
            return doHybridSearch(opts);
    }
}

// ─── Vector only ───

async function doVectorSearch(opts: SearchOptions): Promise<SearchResult[]> {
    if (!opts.embedCfg) throw new Error("Vector search requires embedding config");
    const rows = await vectorSearch(opts.dbPath, opts.tableName, opts.query, opts.embedCfg, opts.limit);
    return normalizeScores(rows, "_distance", true);
}

// ─── Keyword only ───

async function doKeywordSearch(opts: SearchOptions): Promise<SearchResult[]> {
    const rows = await keywordSearch(opts.dbPath, opts.tableName, opts.query, opts.limit, opts.ftsColumns);
    return normalizeScores(rows, "_score", false);
}

// ─── Hybrid: vector + keyword → merge → optional rerank ───

async function doHybridSearch(opts: SearchOptions): Promise<SearchResult[]> {
    if (!opts.embedCfg) throw new Error("Hybrid search requires embedding config");

    const fetchLimit = opts.topK;

    // Run both searches in parallel
    const [vectorRows, keywordRows] = await Promise.all([
        vectorSearch(opts.dbPath, opts.tableName, opts.query, opts.embedCfg, fetchLimit).catch(() => [] as LanceDbRow[]),
        keywordSearch(opts.dbPath, opts.tableName, opts.query, fetchLimit, opts.ftsColumns).catch(() => [] as LanceDbRow[]),
    ]);

    // Normalize scores
    const vectorScored = normalizeScores(vectorRows, "_distance", true);
    const keywordScored = normalizeScores(keywordRows, "_score", false);

    // Merge and deduplicate by id, combining scores
    const merged = mergeResults(vectorScored, keywordScored);

    // Optional rerank
    if (opts.rerankCfg && merged.length > 1) {
        return await applyRerank(merged, opts.query, opts.rerankCfg, opts.limit);
    }

    // Sort by combined score descending, take top limit
    merged.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    return merged.slice(0, opts.limit);
}

// ─── Normalize distance/score to 0-1 range (1 = best) ───

function normalizeScores(rows: LanceDbRow[], field: string, isDistance: boolean): SearchResult[] {
    if (rows.length === 0) return [];

    const values = rows.map((r) => Number(r[field]) || 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    return rows.map((row, i) => {
        const raw = values[i];
        // Distance: lower is better → invert. Score: higher is better → keep.
        const normalized = isDistance ? 1 - (raw - min) / range : (raw - min) / range;
        return { ...row, _score: normalized } as SearchResult;
    });
}

// ─── Merge two scored result sets by id ───

function mergeResults(vectorResults: SearchResult[], keywordResults: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();
    const VECTOR_WEIGHT = 0.5;
    const KEYWORD_WEIGHT = 0.5;

    for (const row of vectorResults) {
        const id = String(row.id ?? "");
        if (!id) continue;
        map.set(id, { ...row, _score: (row._score ?? 0) * VECTOR_WEIGHT });
    }

    for (const row of keywordResults) {
        const id = String(row.id ?? "");
        if (!id) continue;
        const existing = map.get(id);
        if (existing) {
            existing._score = (existing._score ?? 0) + (row._score ?? 0) * KEYWORD_WEIGHT;
        } else {
            map.set(id, { ...row, _score: (row._score ?? 0) * KEYWORD_WEIGHT });
        }
    }

    return Array.from(map.values());
}

// ─── Apply reranker to merged results ───

async function applyRerank(
    rows: SearchResult[],
    query: string,
    rerankCfg: RerankConfig,
    limit: number,
): Promise<SearchResult[]> {
    const documents = rows.map((row) => {
        return ["content", "summary", "subject", "title"]
            .map((k) => (typeof row[k] === "string" ? (row[k] as string) : ""))
            .filter(Boolean)
            .join(" ");
    });

    const reranked = await rerankDocuments(query, documents, rerankCfg, limit);
    return reranked.map((r) => ({
        ...rows[r.index],
        _score: r.relevance_score,
    }));
}
