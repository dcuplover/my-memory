import type { LlmConfig } from "../llm/client";
import type { EmbedConfig } from "../embedding";
import { extractMemories } from "./extract";
import { executeMemoryDecision, type DecisionSummary } from "../llm/decision";
import { MemoryLayer, getTableForMemoryLayer } from "./layers";
import { ensureTable } from "../db/schema";
import { getPluginConfig, getLanceDbPath, getEmbedConfig, getLlmConfig, getDistillLlmConfig, getKuzuDbPath, DEFAULT_EMBED_DIMENSIONS } from "../config";
import { startTracker, clearTracker } from "../tracker";
import { extractAndStoreTriples } from "../graph/extract";

export type AddMemoryResult = {
    attitudes: DecisionSummary;
    facts: DecisionSummary;
    knowledge: DecisionSummary;
    preferences: DecisionSummary;
    totalAdded: number;
    totalUpdated: number;
    totalDeleted: number;
    trackLog?: string;
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
    const distillCfg = getDistillLlmConfig(api) as LlmConfig | undefined;
    if (!embedCfg || !llmCfg) throw new Error("Embedding or LLM config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;

    const tracker = startTracker("记忆添加");

    try {
        // Ensure all memory tables exist
        await tracker.track("初始化表", async () => {
            for (const layer of Object.values(MemoryLayer)) {
                await ensureTable(dbPath, getTableForMemoryLayer(layer), dims);
            }
        });

        // Step 1: Extract memories from text (two-step: distill → classify)
        const extraction = await tracker.track("LLM记忆提取", () =>
            extractMemories(inputText, llmCfg, distillCfg),
            `输入长度: ${inputText.length}字符`,
        );

        // Step 1.5: Extract and store graph triples
        const kuzuPath = getKuzuDbPath(api);
        if (kuzuPath) {
            await tracker.track("图谱三元组", async () => {
                try {
                    const gr = await extractAndStoreTriples(kuzuPath, extraction, llmCfg);
                    return `提取${gr.extracted}条，存储${gr.stored}条`;
                } catch (err) {
                    api.logger?.warn?.(`图谱三元组提取失败: ${err}`);
                }
            });
        }

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
    } finally {
        clearTracker();
    }
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
        ["preferences", "价值观选择层"],
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

    if (result.trackLog) {
        lines.push("");
        lines.push("── 性能日志 ──");
        lines.push(result.trackLog);
    }

    return lines.join("\n");
}
