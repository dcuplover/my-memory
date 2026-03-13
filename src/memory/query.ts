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

type LayerSelection = {
    layers: string[];
    reason: string;
};

/**
 * Main memory query logic for before_prompt_build hook.
 *
 * 1. Use LLM to determine which layers to query
 * 2. Execute hybrid search on selected memory layers
 * 3. For file layers: only show summary count unless explicitly requested
 * 4. Sort by credibility, format and return prependContext
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

    // Step 1: LLM determines which layers to query
    let selectedMemoryLayers: MemoryLayer[];
    let selectedFileLayers: FileLayer[];

    try {
        const messages = buildLayerSelectionMessages(normalizedPrompt);
        const selection = await chatCompletionJson<LayerSelection>(messages, llmCfg, { temperature: 0.1 });
        selectedMemoryLayers = parseMemoryLayers(selection.layers);
        selectedFileLayers = parseFileLayers(selection.layers);
    } catch {
        // Fallback: query all memory layers
        selectedMemoryLayers = [...ALL_MEMORY_LAYERS];
        selectedFileLayers = [];
    }

    // If nothing selected, default to all memory layers
    if (selectedMemoryLayers.length === 0 && selectedFileLayers.length === 0) {
        selectedMemoryLayers = [...ALL_MEMORY_LAYERS];
    }

    const contextSections: (string | undefined)[] = [];
    const searchMode: SearchMode = "hybrid";

    // Step 2: Search selected memory layers
    for (const layer of selectedMemoryLayers) {
        const tableName = getTableForMemoryLayer(layer);
        try {
            const results = await search({
                dbPath,
                tableName,
                query: normalizedPrompt,
                mode: searchMode,
                limit: resultLimit,
                topK,
                embedCfg,
                rerankCfg,
            });
            const label = LAYER_DESCRIPTIONS[layer];
            contextSections.push(formatMemoryResults(results, label));
        } catch (err) {
            api.logger?.info?.(`Memory layer ${layer} search failed: ${String(err)}`);
        }
    }

    // Step 3: For file layers — only show summary unless explicitly selected
    for (const layer of selectedFileLayers) {
        const tableName = getTableForFileLayer(layer);
        try {
            const results = await search({
                dbPath,
                tableName,
                query: normalizedPrompt,
                mode: searchMode,
                limit: resultLimit,
                topK,
                embedCfg,
                rerankCfg,
            });
            const label = LAYER_DESCRIPTIONS[layer];
            // File layers: show full results since LLM explicitly selected them
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
            const results = await search({
                dbPath,
                tableName,
                query: normalizedPrompt,
                mode: "vector",
                limit: 3,
                topK: 3,
                embedCfg,
            });
            if (results.length > 0) {
                const label = LAYER_DESCRIPTIONS[layer];
                contextSections.push(formatFileSummary(tableName, results.length, label));
            }
        } catch {
            // Silently skip
        }
    }

    return assembleContext(contextSections);
}
