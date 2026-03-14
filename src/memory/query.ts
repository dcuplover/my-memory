import { search, type SearchMode, type SearchResult } from "../search/hybrid";
import { formatMemoryResults, formatFileSummary, assembleContext } from "../formatter";
import {
    MemoryLayer,
    FileLayer,
    ALL_MEMORY_LAYERS,
    getTableForMemoryLayer,
    getTableForFileLayer,
    LAYER_DESCRIPTIONS,
} from "./layers";
import {
    getPluginConfig,
    getLanceDbPath,
    getEmbedConfig,
    getRerankConfig,
    getLayerScoreConfig,
    DEFAULT_RESULT_LIMIT,
    DEFAULT_TOP_K,
    DEFAULT_MIN_PROMPT_LENGTH,
    type LayerScoreConfig,
} from "../config";
import type { EmbedConfig } from "../embedding";
import type { RerankConfig } from "../search/reranker";
import { startTracker, clearTracker } from "../tracker";

// ─── 关键词规则路由（替代 LLM 层级判断，0ms 完成） ───

const DIARY_KEYWORDS = /日记|日志|diary|journal/i;
const DOCUMENT_KEYWORDS = /文档|文件|文件库|document|file/i;
const ATTITUDE_KEYWORDS = /态度|看法|感受|觉得|认为|怎么看|感觉|讨厌|喜欢|喜不喜欢|opinion|attitude|feel/i;
const PREFERENCE_KEYWORDS = /偏好|价值观|倾向|取舍|权衡|优先|选择方案|哪条路|哪种方式|稳定还是|简单还是|长远|眼前|trade.?off|prefer|priority|principle/i;
const KNOWLEDGE_KEYWORDS = /怎么做|该不该|最佳实践|如何|方法|步骤|how to|best practice|应该|不应该|规则/i;
const FACT_KEYWORDS = /是什么|什么是|定义|概念|是谁|哪里|什么时候|fact|what is|who is/i;

function selectLayersByKeywords(query: string): { memoryLayers: MemoryLayer[]; fileLayers: FileLayer[] } {
    const memoryLayers: MemoryLayer[] = [];
    const fileLayers: FileLayer[] = [];

    // 文件层：仅在明确提到时选中
    if (DIARY_KEYWORDS.test(query)) fileLayers.push(FileLayer.Diary);
    if (DOCUMENT_KEYWORDS.test(query)) fileLayers.push(FileLayer.Document);

    // 记忆层：按关键词匹配
    if (ATTITUDE_KEYWORDS.test(query)) memoryLayers.push(MemoryLayer.Attitude);
    if (PREFERENCE_KEYWORDS.test(query)) memoryLayers.push(MemoryLayer.Preference);
    if (KNOWLEDGE_KEYWORDS.test(query)) memoryLayers.push(MemoryLayer.Knowledge);
    if (FACT_KEYWORDS.test(query)) memoryLayers.push(MemoryLayer.Fact);

    // 如果没匹配到任何记忆层，默认查全部四层
    if (memoryLayers.length === 0 && fileLayers.length === 0) {
        memoryLayers.push(...ALL_MEMORY_LAYERS);
    }

    return { memoryLayers, fileLayers };
}

// ─── 分层评分：similarity × credibility × recency × log₂(evidence+1) ───

function applyLayerScoring(results: SearchResult[], scoreCfg: LayerScoreConfig): SearchResult[] {
    const now = Date.now();
    const halfLifeMs = scoreCfg.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
    const lambda = Math.LN2 / halfLifeMs;

    const scored = results.map(r => {
        const similarity = r._score ?? 0;
        const credibility = Number(r.credibility ?? 0) || 0.5;
        const updatedAt = r.updatedAt ? new Date(String(r.updatedAt)).getTime() : now;
        const ageMs = Math.max(0, now - updatedAt);
        const recencyWeight = Math.exp(-lambda * ageMs);
        const evidence = Math.max(1, Number(r.evidence ?? 1));
        const evidenceBoost = Math.log2(evidence + 1);
        const finalScore = similarity * credibility * recencyWeight * evidenceBoost;
        return { ...r, _finalScore: finalScore };
    });
    return scored
        .filter(r => (r._finalScore ?? 0) >= scoreCfg.scoreThreshold)
        .sort((a, b) => (b._finalScore ?? 0) - (a._finalScore ?? 0))
        .slice(0, scoreCfg.layerTopK);
}

/**
 * Main memory query logic for before_prompt_build hook.
 */
export async function queryMemory(api: any, prompt: string): Promise<string | undefined> {
    const cfg = getPluginConfig(api);
    const dbPath = getLanceDbPath(api);
    if (!dbPath) return undefined;

    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length < DEFAULT_MIN_PROMPT_LENGTH) return undefined;

    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;

    if (!embedCfg) {
        api.logger?.warn?.("Memory query skipped: missing embed config");
        return undefined;
    }

    const resultLimit = Math.max(cfg.resultLimit ?? DEFAULT_RESULT_LIMIT, 1);
    const topK = Math.max(cfg.topK ?? DEFAULT_TOP_K, resultLimit);

    const tracker = startTracker("记忆查询");

    try {
        // Step 1: 关键词规则路由（替代 LLM，0ms）
        const { memoryLayers: selectedMemoryLayers, fileLayers: selectedFileLayers } =
            selectLayersByKeywords(normalizedPrompt);

        tracker.track("关键词路由", () =>
            Promise.resolve({ memoryLayers: selectedMemoryLayers, fileLayers: selectedFileLayers }),
            `memory=[${selectedMemoryLayers}] file=[${selectedFileLayers}]`,
        );

        const searchMode: SearchMode = "hybrid";

        // Step 2: 并行执行所有搜索
        const searchTasks: Array<Promise<{ type: "memory" | "file" | "summary"; layer: string; results: SearchResult[] }>> = [];

        // 选中的记忆层 — 全量搜索
        for (const layer of selectedMemoryLayers) {
            const tableName = getTableForMemoryLayer(layer);
            searchTasks.push(
                search({ dbPath, tableName, query: normalizedPrompt, mode: searchMode, limit: resultLimit, topK, embedCfg, rerankCfg })
                    .then((results) => ({ type: "memory" as const, layer, results }))
                    .catch(() => ({ type: "memory" as const, layer, results: [] })),
            );
        }

        // 选中的文件层 — 全量搜索
        for (const layer of selectedFileLayers) {
            const tableName = getTableForFileLayer(layer);
            searchTasks.push(
                search({ dbPath, tableName, query: normalizedPrompt, mode: searchMode, limit: resultLimit, topK, embedCfg, rerankCfg })
                    .then((results) => ({ type: "file" as const, layer, results }))
                    .catch(() => ({ type: "file" as const, layer, results: [] })),
            );
        }

        // 未选中的文件层 — 概要检查（仅向量搜索，更快）
        const unselectedFileLayers = Object.values(FileLayer).filter(
            (l) => !selectedFileLayers.includes(l),
        );
        for (const layer of unselectedFileLayers) {
            const tableName = getTableForFileLayer(layer);
            searchTasks.push(
                search({ dbPath, tableName, query: normalizedPrompt, mode: "vector", limit: 3, topK: 3, embedCfg })
                    .then((results) => ({ type: "summary" as const, layer, results }))
                    .catch(() => ({ type: "summary" as const, layer, results: [] })),
            );
        }

        const allResults = await tracker.track("并行检索", () => Promise.all(searchTasks),
            `共 ${searchTasks.length} 个搜索任务`,
        );

        // Step 3: 分层评分 + 阈值过滤 + TopK 截断
        const contextSections: (string | undefined)[] = [];

        for (const { type, layer, results } of allResults) {
            const scoreCfg = getLayerScoreConfig(api, layer);
            const filtered = applyLayerScoring(results, scoreCfg);

            if (type === "summary") {
                if (filtered.length > 0) {
                    const fileLayer = layer as FileLayer;
                    const label = LAYER_DESCRIPTIONS[fileLayer];
                    contextSections.push(formatFileSummary(getTableForFileLayer(fileLayer), filtered.length, label));
                }
            } else {
                const layerKey = layer as MemoryLayer | FileLayer;
                const label = LAYER_DESCRIPTIONS[layerKey];
                contextSections.push(formatMemoryResults(filtered, label));
            }
        }

        const result = assembleContext(contextSections);

        api.logger?.info?.(tracker.toLogString());

        return result;
    } finally {
        clearTracker();
    }
}
