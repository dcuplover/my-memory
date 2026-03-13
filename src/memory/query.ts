import { chatCompletionJson, type LlmConfig } from "../llm/client";
import { buildLayerSelectionMessages } from "../llm/prompts";
import { search, type SearchMode, type SearchResult } from "../search/hybrid";
import { formatMemoryResults, formatFileSummary, assembleContext } from "../formatter";
import {
    MemoryLayer,
    FileLayer,
    ALL_MEMORY_LAYERS,
    getTableForMemoryLayer,
    getTableForFileLayer,
    LAYER_DESCRIPTIONS,
    parseMemoryLayers,
    parseFileLayers,
} from "./layers";
import {
    getPluginConfig,
    getLanceDbPath,
    getEmbedConfig,
    getLlmConfig,
    getRerankConfig,
    DEFAULT_RESULT_LIMIT,
    DEFAULT_TOP_K,
    DEFAULT_MIN_PROMPT_LENGTH,
} from "../config";
import type { EmbedConfig } from "../embedding";
import type { RerankConfig } from "../search/reranker";
import { startTracker, clearTracker } from "../tracker";

type LayerSelection = {
    layers: string[];
    reason: string;
};

/**
 * Main memory query logic for before_prompt_build hook.
 */
export async function queryMemory(api: any, prompt: string): Promise<string | undefined> {
    const cfg = getPluginConfig(api);
    const dbPath = getLanceDbPath(api);
    if (!dbPath) return undefined;

    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length < (cfg.resultLimit ?? DEFAULT_MIN_PROMPT_LENGTH)) return undefined;

    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const llmCfg = getLlmConfig(api) as LlmConfig | undefined;
    const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;

    if (!embedCfg || !llmCfg) {
        api.logger?.warn?.("Memory query skipped: missing embed or LLM config");
        return undefined;
    }

    const resultLimit = Math.max(cfg.resultLimit ?? DEFAULT_RESULT_LIMIT, 1);
    const topK = Math.max(cfg.topK ?? DEFAULT_TOP_K, resultLimit);

    const tracker = startTracker("记忆查询");

    try {
        // Step 1: LLM determines which layers to query
        let selectedMemoryLayers: MemoryLayer[];
        let selectedFileLayers: FileLayer[];

        try {
            const { data: selection } = await tracker.track("LLM层级判断", () =>
                chatCompletionJson<LayerSelection>(
                    buildLayerSelectionMessages(normalizedPrompt),
                    llmCfg,
                    { temperature: 0.1, stepName: "LLM层级判断" },
                ),
                `prompt: "${normalizedPrompt.slice(0, 50)}..."`,
            );
            selectedMemoryLayers = parseMemoryLayers(selection.layers);
            selectedFileLayers = parseFileLayers(selection.layers);
        } catch {
            selectedMemoryLayers = [...ALL_MEMORY_LAYERS];
            selectedFileLayers = [];
        }

        if (selectedMemoryLayers.length === 0 && selectedFileLayers.length === 0) {
            selectedMemoryLayers = [...ALL_MEMORY_LAYERS];
        }

        const contextSections: (string | undefined)[] = [];
        const searchMode: SearchMode = "hybrid";

        // Step 2: Search selected memory layers
        for (const layer of selectedMemoryLayers) {
            const tableName = getTableForMemoryLayer(layer);
            try {
                const results = await tracker.track(`检索:${layer}`, () =>
                    search({ dbPath, tableName, query: normalizedPrompt, mode: searchMode, limit: resultLimit, topK, embedCfg, rerankCfg }),
                    `table=${tableName}`,
                );
                const label = LAYER_DESCRIPTIONS[layer];
                contextSections.push(formatMemoryResults(results, label));
            } catch (err) {
                api.logger?.info?.(`Memory layer ${layer} search failed: ${String(err)}`);
            }
        }

        // Step 3: Search selected file layers
        for (const layer of selectedFileLayers) {
            const tableName = getTableForFileLayer(layer);
            try {
                const results = await tracker.track(`检索:${layer}`, () =>
                    search({ dbPath, tableName, query: normalizedPrompt, mode: searchMode, limit: resultLimit, topK, embedCfg, rerankCfg }),
                    `table=${tableName}`,
                );
                const label = LAYER_DESCRIPTIONS[layer];
                contextSections.push(formatMemoryResults(results, label));
            } catch (err) {
                api.logger?.info?.(`File layer ${layer} search failed: ${String(err)}`);
            }
        }

        // Step 4: Check unselected file layers for summary count
        const unselectedFileLayers = Object.values(FileLayer).filter(
            (l) => !selectedFileLayers.includes(l),
        );
        for (const layer of unselectedFileLayers) {
            const tableName = getTableForFileLayer(layer);
            try {
                const results = await tracker.track(`概要检查:${layer}`, () =>
                    search({ dbPath, tableName, query: normalizedPrompt, mode: "vector", limit: 3, topK: 3, embedCfg }),
                );
                if (results.length > 0) {
                    const label = LAYER_DESCRIPTIONS[layer];
                    contextSections.push(formatFileSummary(tableName, results.length, label));
                }
            } catch {
                // Silently skip
            }
        }

        const result = assembleContext(contextSections);

        api.logger?.info?.(tracker.toLogString());

        return result;
    } finally {
        clearTracker();
    }
}
