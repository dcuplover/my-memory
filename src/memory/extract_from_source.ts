import type { LlmConfig } from "../llm/client";
import type { EmbedConfig } from "../embedding";
import { extractMemories, type ExtractionResult } from "./extract";
import { executeMemoryDecision, type DecisionSummary } from "../llm/decision";
import { MemoryLayer, getTableForMemoryLayer } from "./layers";
import { ensureTable } from "../db/schema";
import { search } from "../search/hybrid";
import { splitIntoChunks } from "../document/chunker";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, basename, extname } from "path";
import {
    TABLE_NAMES,
    getPluginConfig,
    getLanceDbPath,
    getEmbedConfig,
    getLlmConfig,
    getDistillLlmConfig,
    getKuzuDbPath,
    DEFAULT_EMBED_DIMENSIONS,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_EXTRACT_CHUNK_SIZE,
    DEFAULT_RESULT_LIMIT,
    DEFAULT_TOP_K,
    MAX_FILE_READ_BYTES,
    MAX_CONTENT_JOIN_CHARS,
    MAX_DIARY_CHUNK_ROWS,
    MAX_DIARY_DEFAULT_ROWS,
    MAX_DOCUMENT_ROWS,
} from "../config";
import { startTracker, clearTracker } from "../tracker";
import type { AddMemoryResult } from "./add";
import { extractAndStoreTriples } from "../graph/extract";

// ─── 提取上限 ───
const MAX_EXTRACT_CHUNK_OVERLAP = 200;

/** 安全读取文件，检查大小上限 */
function safeReadFile(fullPath: string): string {
    const size = statSync(fullPath).size;
    if (size > MAX_FILE_READ_BYTES) {
        throw new Error(`文件过大 (${(size / 1024 / 1024).toFixed(1)} MB)，上限 ${MAX_FILE_READ_BYTES / 1024 / 1024} MB: ${fullPath}`);
    }
    return readFileSync(fullPath, "utf-8");
}

/** 安全拼接内容，超过上限时截断 */
function safeJoin(parts: string[], separator: string): string {
    let result = "";
    for (const part of parts) {
        if (result.length + separator.length + part.length > MAX_CONTENT_JOIN_CHARS) {
            result += separator + `[...截断：已达 ${MAX_CONTENT_JOIN_CHARS} 字符上限]`;
            break;
        }
        result += (result ? separator : "") + part;
    }
    return result;
}

/**
 * 合并多次提取的结果
 */
function mergeExtractions(results: ExtractionResult[]): ExtractionResult {
    return {
        attitudes: results.flatMap((r) => r.attitudes),
        facts: results.flatMap((r) => r.facts),
        knowledge: results.flatMap((r) => r.knowledge),
        preferences: results.flatMap((r) => r.preferences),
        statements: results.flatMap((r) => r.statements),
    };
}

/**
 * 对长文本分段提取四层记忆，确保不遗漏
 */
async function extractFromLongText(
    text: string,
    llmCfg: LlmConfig,
    tracker: ReturnType<typeof startTracker>,
    distillCfg?: LlmConfig,
    extractChunkSize: number = DEFAULT_EXTRACT_CHUNK_SIZE,
): Promise<ExtractionResult> {
    if (text.length <= extractChunkSize) {
        return tracker.track("LLM记忆提取", () => extractMemories(text, llmCfg, distillCfg), `单段 ${text.length}字符`);
    }

    // 分段提取
    const chunks = splitIntoChunks(text, extractChunkSize, MAX_EXTRACT_CHUNK_OVERLAP);
    const results: ExtractionResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = await tracker.track(
            `LLM记忆提取(${i + 1}/${chunks.length})`,
            () => extractMemories(chunk.text, llmCfg, distillCfg),
            `${chunk.text.length}字符`,
        );
        results.push(result);
    }

    return mergeExtractions(results);
}

/**
 * 执行四层决策流程（与 addMemory 相同的后半段逻辑）
 */
async function runDecisionPipeline(
    api: any,
    extraction: ExtractionResult,
    channel: string,
    dbPath: string,
    embedCfg: EmbedConfig,
    llmCfg: LlmConfig,
    dims: number,
    tracker: ReturnType<typeof startTracker>,
): Promise<AddMemoryResult> {
    // Ensure all memory tables exist
    await tracker.track("初始化表", async () => {
        for (const layer of Object.values(MemoryLayer)) {
            await ensureTable(dbPath, getTableForMemoryLayer(layer), dims);
        }
    });

    // Graph triple extraction
    const kuzuPath = getKuzuDbPath(api);
    if (kuzuPath) {
        await tracker.track("图谱三元组", async () => {
            try {
                const gr = await extractAndStoreTriples(kuzuPath, extraction.statements, llmCfg);
                return `提取${gr.extracted}条，存储${gr.stored}条`;
            } catch (err) {
                api.logger?.warn?.(`图谱三元组提取失败: ${err}`);
            }
        });
    }

    const attitudesFacts = extraction.attitudes.map((a) => ({
        content: a.content,
        extraFields: { subject: a.subject, attitude: a.attitude },
    }));
    const factsFacts = extraction.facts.map((f) => ({
        content: f.content,
        extraFields: { subject: f.subject, definition: f.definition },
    }));
    const knowledgeFacts = extraction.knowledge.map((k) => ({
        content: k.content,
        extraFields: { scenario: k.scenario, action: k.action },
    }));
    const preferencesFacts = extraction.preferences.map((p) => ({
        content: p.content,
        extraFields: { scenario: p.scenario, options: p.options, preferred: p.preferred },
    }));

    const [attitudes, facts, knowledge, preferences] = await Promise.all([
        tracker.track("决策:态度层", () =>
            executeMemoryDecision(dbPath, getTableForMemoryLayer(MemoryLayer.Attitude), attitudesFacts, channel, api, embedCfg, llmCfg),
            `${attitudesFacts.length}条待处理`,
        ),
        tracker.track("决策:事实层", () =>
            executeMemoryDecision(dbPath, getTableForMemoryLayer(MemoryLayer.Fact), factsFacts, channel, api, embedCfg, llmCfg),
            `${factsFacts.length}条待处理`,
        ),
        tracker.track("决策:知识层", () =>
            executeMemoryDecision(dbPath, getTableForMemoryLayer(MemoryLayer.Knowledge), knowledgeFacts, channel, api, embedCfg, llmCfg),
            `${knowledgeFacts.length}条待处理`,
        ),
        tracker.track("决策:偏好层", () =>
            executeMemoryDecision(dbPath, getTableForMemoryLayer(MemoryLayer.Preference), preferencesFacts, channel, api, embedCfg, llmCfg),
            `${preferencesFacts.length}条待处理`,
        ),
    ]);

    const trackLog = tracker.toLogString();
    api.logger?.info?.(trackLog);

    return {
        attitudes,
        facts,
        knowledge,
        preferences,
        totalAdded: attitudes.added + facts.added + knowledge.added + preferences.added,
        totalUpdated: attitudes.updated + facts.updated + knowledge.updated + preferences.updated,
        totalDeleted: attitudes.deleted + facts.deleted + knowledge.deleted + preferences.deleted,
        trackLog,
    };
}

// ═════════════════════════════════════════════════════════
// 从日记中提取四层记忆
// ═════════════════════════════════════════════════════════

export type ExtractFromDiaryOptions = {
    /** 按关键词/语义搜索日记，留空则提取未提取过的日记 */
    query?: string;
    /** 按日期筛选，格式 YYYY-MM-DD */
    date?: string;
    /** 按 source_id 指定某篇日记 */
    sourceId?: string;
    /** 指定磁盘文件路径，自动导入为日记并提取记忆 */
    filePath?: string;
    /** 强制重新提取（包括已提取过的日记） */
    force?: boolean;
};

/**
 * 从已存储的日记中提取四层记忆。
 * 默认只处理未提取过的新日记（extracted = false），传 force=true 可重新提取全部。
 * 流程：查询日记内容 → 分段 LLM 提取 → 去重决策 → 写入记忆层
 */
export async function extractMemoryFromDiary(
    api: any,
    options: ExtractFromDiaryOptions = {},
): Promise<AddMemoryResult> {
    const dbPath = getLanceDbPath(api);
    if (!dbPath) throw new Error("LanceDB path not configured");

    const cfg = getPluginConfig(api);
    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const llmCfg = getLlmConfig(api) as LlmConfig | undefined;
    const distillCfg = getDistillLlmConfig(api) as LlmConfig | undefined;
    if (!embedCfg || !llmCfg) throw new Error("Embedding or LLM config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;
    const tracker = startTracker("日记记忆提取");

    try {
        // Step 1: 获取日记内容
        let diaryContent: string;
        let processedSourceIds: string[];

        if (options.filePath) {
            // 从磁盘文件读取
            const fullPath = resolve(options.filePath);
            if (!existsSync(fullPath)) throw new Error(`文件不存在: ${fullPath}`);
            diaryContent = await tracker.track("读取磁盘文件", async () => safeReadFile(fullPath), fullPath);
            processedSourceIds = [];
        } else {
            // 从数据库查询（默认只获取未提取过的）
            const result = await tracker.track(
                "获取日记内容",
                async () => fetchDiaryContent(dbPath, embedCfg, options, cfg, dims),
            );
            diaryContent = result.content;
            processedSourceIds = result.sourceIds;
        }

        if (!diaryContent || diaryContent.trim().length === 0) {
            const msg = options.force
                ? "未找到符合条件的日记内容"
                : "没有未提取过的新日记（如需重新提取，请使用 force 参数）";
            throw new Error(msg);
        }

        // Step 2: 分段提取四层记忆（两步：蒸馏 → 分类）
        const extractChunkSize = cfg.extractChunkSize ?? DEFAULT_EXTRACT_CHUNK_SIZE;
        const extraction = await extractFromLongText(diaryContent, llmCfg, tracker, distillCfg, extractChunkSize);

        const totalExtracted =
            extraction.attitudes.length +
            extraction.facts.length +
            extraction.knowledge.length +
            extraction.preferences.length;

        if (totalExtracted === 0) {
            api.logger?.info?.(tracker.toLogString());
            return emptyResult(tracker.toLogString());
        }

        // Step 3: 决策流程
        const result = await runDecisionPipeline(api, extraction, "diary", dbPath, embedCfg, llmCfg, dims, tracker);

        // Step 4: 标记已提取的日记
        if (processedSourceIds.length > 0) {
            await tracker.track("标记已提取", async () => {
                const table = await ensureTable(dbPath, TABLE_NAMES.DIARY, dims);
                for (const sid of processedSourceIds) {
                    await table.update({
                        where: `source_id = '${sid.replace(/'/g, "''")}'`,
                        values: { extracted: true },
                    });
                }
            }, `${processedSourceIds.length}篇日记`);
        }

        return result;
    } finally {
        clearTracker();
    }
}

type FetchDiaryResult = {
    content: string;
    /** 本次处理涉及的 source_id 列表，用于后续标记 extracted */
    sourceIds: string[];
};

async function fetchDiaryContent(
    dbPath: string,
    embedCfg: EmbedConfig,
    options: ExtractFromDiaryOptions,
    cfg: any,
    dims: number,
): Promise<FetchDiaryResult> {
    const table = await ensureTable(dbPath, TABLE_NAMES.DIARY, dims);
    const zeroVec = new Array(dims).fill(0);
    const onlyNew = !options.force;

    if (options.sourceId) {
        // 按 source_id 获取某篇日记的所有 chunk
        const rows = await table
            .search(zeroVec)
            .where(`source_id = '${options.sourceId.replace(/'/g, "''")}'`)
            .limit(MAX_DIARY_CHUNK_ROWS)
            .toArray();
        rows.sort((a: any, b: any) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
        return {
            content: safeJoin(rows.map((r: any) => r.content), "\n"),
            sourceIds: [...new Set(rows.map((r: any) => r.source_id as string))],
        };
    }

    if (options.date) {
        // 按日期获取日记（默认只获取未提取过的）
        let filter = `date = '${options.date.replace(/'/g, "''")}'`;
        if (onlyNew) filter += ` AND extracted = false`;
        const rows = await table
            .search(zeroVec)
            .where(filter)
            .limit(MAX_DIARY_CHUNK_ROWS)
            .toArray();
        rows.sort((a: any, b: any) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
        return {
            content: safeJoin(rows.map((r: any) => r.content), "\n"),
            sourceIds: [...new Set(rows.map((r: any) => r.source_id as string))],
        };
    }

    if (options.query) {
        // 语义搜索后提取
        const results = await search({
            dbPath,
            tableName: TABLE_NAMES.DIARY,
            query: options.query,
            mode: "hybrid",
            limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
            topK: cfg.topK ?? DEFAULT_TOP_K,
            embedCfg,
        });
        const filtered = onlyNew ? results.filter((r: any) => !r.extracted) : results;
        return {
            content: safeJoin(filtered.map((r: any) => r.content), "\n\n"),
            sourceIds: [...new Set(filtered.map((r: any) => r.source_id as string).filter(Boolean))],
        };
    }

    // 默认：获取未提取过的日记（force=true 时获取全部）
    let rows: any[];
    if (onlyNew) {
        rows = await table.search(zeroVec).where("extracted = false").limit(MAX_DIARY_DEFAULT_ROWS).toArray();
    } else {
        rows = await table.search(zeroVec).limit(MAX_DIARY_DEFAULT_ROWS).toArray();
    }
    rows.sort((a: any, b: any) => {
        const dateCompare = String(a.date ?? "").localeCompare(String(b.date ?? ""));
        if (dateCompare !== 0) return dateCompare;
        return (a.chunk_index ?? 0) - (b.chunk_index ?? 0);
    });
    return {
        content: safeJoin(rows.map((r: any) => r.content), "\n"),
        sourceIds: [...new Set(rows.map((r: any) => r.source_id as string))],
    };
}

// ═════════════════════════════════════════════════════════
// 从文档中提取四层记忆
// ═════════════════════════════════════════════════════════

export type ExtractFromDocumentOptions = {
    /** 按关键词/语义搜索文档，留空则提取全部文档 */
    query?: string;
    /** 按文件路径查找：先尝试从磁盘读取，找不到则按路径查询数据库 */
    filePath?: string;
    /** 直接传入文档内容（跳过从数据库查询） */
    content?: string;
};

/**
 * 从已存储的文档（或直接传入内容）中提取四层记忆。
 * 流程：获取文档内容 → 分段 LLM 提取 → 去重决策 → 写入记忆层
 */
export async function extractMemoryFromDocument(
    api: any,
    options: ExtractFromDocumentOptions = {},
): Promise<AddMemoryResult> {
    const dbPath = getLanceDbPath(api);
    if (!dbPath) throw new Error("LanceDB path not configured");

    const cfg = getPluginConfig(api);
    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const llmCfg = getLlmConfig(api) as LlmConfig | undefined;
    const distillCfg = getDistillLlmConfig(api) as LlmConfig | undefined;
    if (!embedCfg || !llmCfg) throw new Error("Embedding or LLM config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;
    const tracker = startTracker("文档记忆提取");

    try {
        // Step 1: 获取文档内容
        const docContent = await tracker.track("获取文档内容", async () => {
            if (options.content) return options.content;
            // filePath: 先尝试从磁盘读取，找不到则按路径查数据库
            if (options.filePath) {
                const fullPath = resolve(options.filePath);
                if (existsSync(fullPath)) return safeReadFile(fullPath);
            }
            return fetchDocumentContent(dbPath, embedCfg, options, cfg, dims);
        });

        if (!docContent || docContent.trim().length === 0) {
            throw new Error("未找到符合条件的文档内容");
        }

        // Step 2: 分段提取四层记忆（两步：蒸馏 → 分类）
        const extractChunkSize = cfg.extractChunkSize ?? DEFAULT_EXTRACT_CHUNK_SIZE;
        const extraction = await extractFromLongText(docContent, llmCfg, tracker, distillCfg, extractChunkSize);

        const totalExtracted =
            extraction.attitudes.length +
            extraction.facts.length +
            extraction.knowledge.length +
            extraction.preferences.length;

        if (totalExtracted === 0) {
            api.logger?.info?.(tracker.toLogString());
            return emptyResult(tracker.toLogString());
        }

        // Step 3: 决策流程
        return runDecisionPipeline(api, extraction, "document", dbPath, embedCfg, llmCfg, dims, tracker);
    } finally {
        clearTracker();
    }
}

async function fetchDocumentContent(
    dbPath: string,
    embedCfg: EmbedConfig,
    options: ExtractFromDocumentOptions,
    cfg: any,
    dims: number,
): Promise<string> {
    const table = await ensureTable(dbPath, TABLE_NAMES.DOCUMENT, dims);
    const zeroVec = new Array(dims).fill(0);

    if (options.filePath) {
        const rows = await table
            .search(zeroVec)
            .where(`file_path = '${options.filePath.replace(/'/g, "''")}'`)
            .limit(100)
            .toArray();
        // 文档存的是 summary，拼接所有匹配文档的摘要
        return safeJoin(rows.map((r: any) => `【${r.title || "未命名"}】\n${r.summary}`), "\n\n");
    }

    if (options.query) {
        const results = await search({
            dbPath,
            tableName: TABLE_NAMES.DOCUMENT,
            query: options.query,
            mode: "hybrid",
            limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
            topK: cfg.topK ?? DEFAULT_TOP_K,
            embedCfg,
        });
        return safeJoin(results.map((r: any) => `【${r.title || "未命名"}】\n${r.summary}`), "\n\n");
    }

    // 默认：全部文档
    const rows = await table.search(zeroVec).limit(MAX_DOCUMENT_ROWS).toArray();
    return safeJoin(rows.map((r: any) => `【${r.title || "未命名"}】\n${r.summary}`), "\n\n");
}

// ─── 空结果 helper ───

function emptyResult(trackLog?: string): AddMemoryResult {
    const empty: DecisionSummary = { added: 0, updated: 0, deleted: 0, unchanged: 0 };
    return {
        attitudes: empty,
        facts: empty,
        knowledge: empty,
        preferences: empty,
        totalAdded: 0,
        totalUpdated: 0,
        totalDeleted: 0,
        trackLog,
    };
}
