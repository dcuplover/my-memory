import { search, type SearchMode, type SearchResult } from "../search/hybrid";
import { formatMemoryResults, formatFileSummary, formatGraphExpansion, assembleContext } from "../formatter";
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
    getKuzuDbPath,
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
import { findEntitiesInText, expandEntities } from "../graph/operations";

// ─── 闲聊/问候检测（不需要记忆补充的查询直接跳过） ───

const SKIP_QUERY_PATTERN = /^(你好|hi|hello|hey|嗨|哈喽|早上好|晚上好|下午好|good\s*(morning|afternoon|evening)|早安|晚安|谢谢|thanks|thank\s*you|再见|bye|goodbye|ok|okay|好的|嗯|哦|是的|对|没错|没问题|收到|了解|明白|知道了|好吧|行|可以|sure|yes|no|yeah|yep|nope|got\s*it|sounds?\s*good|fine)[\s!！。.？?~～]*$/i;

function shouldSkipQuery(query: string): boolean {
    return SKIP_QUERY_PATTERN.test(query.trim());
}

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
        const credibility = Number(r.credibility ?? 1) || 1;
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
export async function queryMemory(api: any, prompt: string): Promise<string> {
    const cfg = getPluginConfig(api);
    const dbPath = getLanceDbPath(api);
    if (!dbPath) return "";

    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length < DEFAULT_MIN_PROMPT_LENGTH) return "";

    if (shouldSkipQuery(normalizedPrompt)) {
        api.logger?.info?.("Memory query skipped: casual/greeting query");
        return "";
    }

    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;

    if (!embedCfg) {
        api.logger?.warn?.("Memory query skipped: missing embed config");
        return "";
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
        const existingIds = new Set<string>();

        for (const { type, layer, results } of allResults) {
            const scoreCfg = getLayerScoreConfig(api, layer);
            const filtered = applyLayerScoring(results, scoreCfg);

            // Collect IDs for dedup
            for (const r of filtered) {
                if (r.id) existingIds.add(String(r.id));
            }

            api.logger?.info?.(`[记忆查询] ${layer}: ${results.length}条原始 → ${filtered.length}条过滤后 (阈值${scoreCfg.scoreThreshold})${results.length > 0 ? `, 最高分=${Math.max(...results.map(r => r._score ?? 0)).toFixed(3)}` : ""}`);

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

        // Step 3.5: 图谱关联扩展
        const kuzuPath = getKuzuDbPath(api);
        if (kuzuPath) {
            try {
                await tracker.track("图谱扩展", async () => {
                    // Collect entities from initial results
                    const initialEntities = new Set<string>();
                    for (const { results } of allResults) {
                        for (const r of results) {
                            if (r.subject) initialEntities.add(String(r.subject));
                        }
                    }

                    // Find entities mentioned in query text
                    const queryEntities = await findEntitiesInText(kuzuPath, normalizedPrompt);
                    for (const e of queryEntities) initialEntities.add(e);

                    if (initialEntities.size === 0) return;

                    // Expand via graph (1-2 hops)
                    const expansion = await expandEntities(kuzuPath, [...initialEntities], 2);

                    if (expansion.expandedEntities.length === 0) return;

                    // Format graph relationship paths as context
                    const graphCtx = formatGraphExpansion(expansion.paths);
                    if (graphCtx) contextSections.push(graphCtx);

                    // Search for memories related to expanded entities
                    const expandedQuery = expansion.expandedEntities.slice(0, 5).join(" ");
                    for (const layer of selectedMemoryLayers) {
                        const tableName = getTableForMemoryLayer(layer);
                        try {
                            const expandedResults = await search({
                                dbPath, tableName, query: expandedQuery,
                                mode: "hybrid", limit: 3, topK: 5, embedCfg,
                            });
                            const scoreCfg = getLayerScoreConfig(api, layer);
                            const deduped = expandedResults.filter(r => !existingIds.has(String(r.id)));
                            const scored = applyLayerScoring(deduped, scoreCfg);
                            if (scored.length > 0) {
                                const label = `图谱关联 — ${LAYER_DESCRIPTIONS[layer as MemoryLayer]}`;
                                contextSections.push(formatMemoryResults(scored, label));
                            }
                        } catch {}
                    }

                    return `查询实体${initialEntities.size}个，扩展${expansion.expandedEntities.length}个`;
                });
            } catch (err) {
                api.logger?.warn?.(`图谱扩展失败: ${err}`);
            }
        }

        const result = assembleContext(contextSections);

        api.logger?.info?.(tracker.toLogString());

        return result;
    } finally {
        clearTracker();
    }
}
