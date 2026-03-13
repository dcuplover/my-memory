import type { LlmConfig } from "../llm/client";
import type { EmbedConfig } from "../embedding";
import { extractMemories } from "./extract";
import { executeMemoryDecision, type DecisionSummary } from "../llm/decision";
import { MemoryLayer, getTableForMemoryLayer } from "./layers";
import { ensureTable } from "../db/schema";
import { getPluginConfig, getLanceDbPath, getEmbedConfig, getLlmConfig, DEFAULT_EMBED_DIMENSIONS } from "../config";

export type AddMemoryResult = {
    attitudes: DecisionSummary;
    facts: DecisionSummary;
    knowledge: DecisionSummary;
    preferences: DecisionSummary;
    totalAdded: number;
    totalUpdated: number;
    totalDeleted: number;
};

/**
 * Main memory addition flow:
 * 1. Extract four types of memories from input text via LLM
 * 2. For each type, run Mem0-style two-stage decision (vector recall + LLM decide)
 * 3. Execute CRUD operations
 * 4. Return operation summary
 */
export async function addMemory(
    api: any,
    inputText: string,
    channel: string,
): Promise<AddMemoryResult> {
    const dbPath = getLanceDbPath(api);
    if (!dbPath) throw new Error("LanceDB path not configured");

    const cfg = getPluginConfig(api);
    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const llmCfg = getLlmConfig(api) as LlmConfig | undefined;
    if (!embedCfg || !llmCfg) throw new Error("Embedding or LLM config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;

    // Ensure all memory tables exist
    for (const layer of Object.values(MemoryLayer)) {
        await ensureTable(dbPath, getTableForMemoryLayer(layer), dims);
    }

    // Step 1: Extract memories from text
    const extraction = await extractMemories(inputText, llmCfg);

    // Step 2 & 3: Decision + CRUD for each layer
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
        executeMemoryDecision(
            dbPath, getTableForMemoryLayer(MemoryLayer.Attitude),
            attitudesFacts, channel, api, embedCfg, llmCfg,
        ),
        executeMemoryDecision(
            dbPath, getTableForMemoryLayer(MemoryLayer.Fact),
            factsFacts, channel, api, embedCfg, llmCfg,
        ),
        executeMemoryDecision(
            dbPath, getTableForMemoryLayer(MemoryLayer.Knowledge),
            knowledgeFacts, channel, api, embedCfg, llmCfg,
        ),
        executeMemoryDecision(
            dbPath, getTableForMemoryLayer(MemoryLayer.Preference),
            preferencesFacts, channel, api, embedCfg, llmCfg,
        ),
    ]);

    return {
        attitudes,
        facts,
        knowledge,
        preferences,
        totalAdded: attitudes.added + facts.added + knowledge.added + preferences.added,
        totalUpdated: attitudes.updated + facts.updated + knowledge.updated + preferences.updated,
        totalDeleted: attitudes.deleted + facts.deleted + knowledge.deleted + preferences.deleted,
    };
}

/**
 * Format add memory result as a human-readable summary.
 */
export function formatAddResult(result: AddMemoryResult): string {
    const lines: string[] = ["记忆处理完成："];

    const layerEntries: [keyof AddMemoryResult, string][] = [
        ["attitudes", "态度层"],
        ["facts", "事实层"],
        ["knowledge", "客观知识层"],
        ["preferences", "主观选择层"],
    ];

    for (const [key, label] of layerEntries) {
        const s = result[key] as DecisionSummary;
        if (s.added + s.updated + s.deleted > 0) {
            const parts: string[] = [];
            if (s.added > 0) parts.push(`新增 ${s.added}`);
            if (s.updated > 0) parts.push(`更新 ${s.updated}`);
            if (s.deleted > 0) parts.push(`删除 ${s.deleted}`);
            lines.push(`  ${label}: ${parts.join("、")}`);
        }
    }

    lines.push(`总计: 新增 ${result.totalAdded}、更新 ${result.totalUpdated}、删除 ${result.totalDeleted}`);
    return lines.join("\n");
}
