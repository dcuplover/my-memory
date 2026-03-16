import type { LanceDbRow } from "@lancedb/lancedb";

// ─── Plugin ID ───
export const PLUGIN_ID = "my-memory";

// ─── Table Names ───
export const TABLE_NAMES = {
    ATTITUDE: "memory_attitude",
    FACT: "memory_fact",
    KNOWLEDGE: "memory_knowledge",
    PREFERENCE: "memory_preference",
    DIARY: "file_diary",
    DOCUMENT: "file_document",
    WATCH_STATE: "file_watch_state",
} as const;

export type TableName = (typeof TABLE_NAMES)[keyof typeof TABLE_NAMES];

// ─── Memory Layers ───
export enum MemoryLayer {
    Attitude = "attitude",
    Fact = "fact",
    Knowledge = "knowledge",
    Preference = "preference",
}

export enum FileLayer {
    Diary = "diary",
    Document = "document",
}

export const MEMORY_LAYER_TABLE_MAP: Record<MemoryLayer, TableName> = {
    [MemoryLayer.Attitude]: TABLE_NAMES.ATTITUDE,
    [MemoryLayer.Fact]: TABLE_NAMES.FACT,
    [MemoryLayer.Knowledge]: TABLE_NAMES.KNOWLEDGE,
    [MemoryLayer.Preference]: TABLE_NAMES.PREFERENCE,
};

export const FILE_LAYER_TABLE_MAP: Record<FileLayer, TableName> = {
    [FileLayer.Diary]: TABLE_NAMES.DIARY,
    [FileLayer.Document]: TABLE_NAMES.DOCUMENT,
};

// ─── Defaults ───
export const DEFAULT_RESULT_LIMIT = 5;
export const DEFAULT_TOP_K = 10;
export const DEFAULT_MIN_PROMPT_LENGTH = 5;
export const DEFAULT_EMBED_DIMENSIONS = 1536;
export const DEFAULT_CHUNK_SIZE = 512;
export const DEFAULT_CHUNK_OVERLAP = 128;
export const DEFAULT_EXTRACT_CHUNK_SIZE = 10000; // ≈5k tokens
export const DEFAULT_LLM_TIMEOUT_SECONDS = 300; // 5 分钟
export const DEFAULT_FTS_COLUMNS = ["content"];
export const DEFAULT_MEMORY_FTS_COLUMNS = ["content", "subject"];
export const DEFAULT_DIARY_FTS_COLUMNS = ["content", "title"];
export const DEFAULT_DOCUMENT_FTS_COLUMNS = ["summary", "title"];
export const VECTOR_RECALL_TOP_K = 5;

// ─── Safety Limits (prevent OOM) ───
/** 单次读取磁盘文件的最大字节数（10 MB） */
export const MAX_FILE_READ_BYTES = 10 * 1024 * 1024;
/** join() 拼接后的最大字符数（500 KB），超出截断 */
export const MAX_CONTENT_JOIN_CHARS = 500_000;
/** 日记按 source_id / date 查询的最大行数 */
export const MAX_DIARY_CHUNK_ROWS = 500;
/** 日记默认(全量)查询的最大行数 */
export const MAX_DIARY_DEFAULT_ROWS = 2000;
/** 文档查询的最大行数 */
export const MAX_DOCUMENT_ROWS = 500;
/** Schema 迁移单次读取的最大行数 */
export const MAX_MIGRATION_ROWS = 5000;
/** Schema 迁移批量写入的每批大小 */
export const MIGRATION_BATCH_SIZE = 500;
/** 文件监听递归目录的最大深度 */
export const MAX_SCAN_DEPTH = 10;
/** 文件监听单次扫描的最大文件数 */
export const MAX_SCAN_FILES = 5000;
/** 分类 prompt 中最大陈述数 */
export const MAX_CLASSIFICATION_STATEMENTS = 200;
/** 决策 prompt 中最大旧记忆候选数 */
export const MAX_DECISION_OLD_MEMORIES = 100;

// ─── Layer Score Config ───
export type LayerScoreConfig = {
    scoreThreshold: number;
    layerTopK: number;
    recencyHalfLifeDays: number;
};

export const DEFAULT_LAYER_SCORE_CONFIG: LayerScoreConfig = {
    scoreThreshold: 0.1,
    layerTopK: 3,
    recencyHalfLifeDays: 30,
};

// ─── Plugin Config Type ───
export type PluginConfig = {
    lanceDbPath?: string;
    ftsColumns?: string[];
    resultLimit?: number;
    topK?: number;
    embedBaseUrl?: string;
    embedModel?: string;
    embedApiKey?: string;
    embedDimensions?: number;
    rerankBaseUrl?: string;
    rerankModel?: string;
    rerankApiKey?: string;
    llmBaseUrl?: string;
    llmModel?: string;
    llmApiKey?: string;
    distillLlmBaseUrl?: string;
    distillLlmModel?: string;
    distillLlmApiKey?: string;
    channelWeightsPath?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    extractChunkSize?: number;
    llmTimeoutSeconds?: number;
    hooksBaseUrl?: string;
    hooksToken?: string;
    notifyChannel?: string;
    notifyTarget?: string;
    layerScoreConfig?: Partial<LayerScoreConfig>;
    layerScoreOverrides?: Record<string, Partial<LayerScoreConfig>>;
    watchPaths?: WatchPathConfig[];
};

// ─── Watch Path Config ───
export type WatchPathConfig = {
    path: string;
    type: "diary" | "document";
    trigger?: "immediate" | "debounce" | "scheduled";
    debounceSeconds?: number;
    intervalMinutes?: number;
    extensions?: string[];
    autoExtract?: boolean;
};

// ─── Config Reader ───
export function getPluginConfig(api: any): PluginConfig {
    return api.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
}

export function getLanceDbPath(api: any): string | undefined {
    return getPluginConfig(api).lanceDbPath?.trim() || undefined;
}

export function getEmbedConfig(api: any) {
    const cfg = getPluginConfig(api);
    const baseUrl = cfg.embedBaseUrl?.trim();
    const model = cfg.embedModel?.trim();
    const apiKey = cfg.embedApiKey?.trim();
    if (!baseUrl || !model || !apiKey) return undefined;
    return {
        baseUrl,
        model,
        apiKey,
        dimensions: cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS,
    };
}

export function getLlmConfig(api: any) {
    const cfg = getPluginConfig(api);
    const baseUrl = cfg.llmBaseUrl?.trim();
    const model = cfg.llmModel?.trim();
    const apiKey = cfg.llmApiKey?.trim();
    if (!baseUrl || !model || !apiKey) return undefined;
    const timeoutMs = (cfg.llmTimeoutSeconds ?? DEFAULT_LLM_TIMEOUT_SECONDS) * 1000;
    return { baseUrl, model, apiKey, timeoutMs, enableThinking: false };
}

/**
 * 蒸馏专用 LLM 配置，未配置时回退到主 LLM 配置。
 */
export function getDistillLlmConfig(api: any) {
    const cfg = getPluginConfig(api);
    const timeoutMs = (cfg.llmTimeoutSeconds ?? DEFAULT_LLM_TIMEOUT_SECONDS) * 1000;
    const baseUrl = cfg.distillLlmBaseUrl?.trim();
    const model = cfg.distillLlmModel?.trim();
    const apiKey = cfg.distillLlmApiKey?.trim();
    if (baseUrl && model && apiKey) return { baseUrl, model, apiKey, enableThinking: false, timeoutMs };
    // 回退到主 LLM 时也关闭思考模式（蒸馏不需要推理）
    const llm = getLlmConfig(api);
    return llm ? { ...llm, enableThinking: false } : undefined;
}

export type HooksConfig = {
    baseUrl: string;
    token: string;
};

export function getHooksConfig(api: any): HooksConfig | undefined {
    const cfg = getPluginConfig(api);
    const baseUrl = cfg.hooksBaseUrl?.trim();
    const token = cfg.hooksToken?.trim();
    if (!baseUrl || !token) return undefined;
    return { baseUrl, token };
}

export type NotifyConfig = {
    channel: string;
    target: string;
};

export function getNotifyConfig(api: any): NotifyConfig | undefined {
    const cfg = getPluginConfig(api);
    const channel = cfg.notifyChannel?.trim();
    const target = cfg.notifyTarget?.trim();
    if (!channel || !target) return undefined;
    return { channel, target };
}

export function getRerankConfig(api: any) {
    const cfg = getPluginConfig(api);
    const baseUrl = cfg.rerankBaseUrl?.trim();
    const model = cfg.rerankModel?.trim();
    const apiKey = cfg.rerankApiKey?.trim();
    if (!baseUrl || !model || !apiKey) return undefined;
    return { baseUrl, model, apiKey };
}

export function getLayerScoreConfig(api: any, layer?: string): LayerScoreConfig {
    const cfg = getPluginConfig(api);
    const base: LayerScoreConfig = { ...DEFAULT_LAYER_SCORE_CONFIG, ...cfg.layerScoreConfig };
    if (layer && cfg.layerScoreOverrides?.[layer]) {
        return { ...base, ...cfg.layerScoreOverrides[layer] };
    }
    return base;
}

// ─── Channel Weights ───
let _channelWeightsCache: Record<string, number> | null = null;

const DEFAULT_CHANNEL_WEIGHTS: Record<string, number> = {
    daily_chat: 0.6,
    document: 0.8,
    diary: 0.7,
    verified: 1.0,
    user_input: 0.9,
};

export function setChannelWeights(weights: Record<string, number>): void {
    _channelWeightsCache = weights;
}

export function getChannelWeights(api: any): Record<string, number> {
    if (_channelWeightsCache) return _channelWeightsCache;
    _channelWeightsCache = { ...DEFAULT_CHANNEL_WEIGHTS };
    return _channelWeightsCache;
}

export function getCredibility(api: any, channel: string): number {
    const weights = getChannelWeights(api);
    return weights[channel] ?? 0.5;
}
