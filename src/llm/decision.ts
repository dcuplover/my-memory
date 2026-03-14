import type { LanceDbRow } from "@lancedb/lancedb";
import { chatCompletionJson, type LlmConfig } from "./client";
import { buildMemoryDecisionMessages, type OldMemoryCandidate } from "./prompts";
import { generateEmbedding, type EmbedConfig } from "../embedding";
import { vectorSearch } from "../search/vector";
import { addRecords, updateRecord, deleteRecord } from "../db/crud";
import { VECTOR_RECALL_TOP_K, getCredibility } from "../config";

export type MemoryAction = {
    event: "ADD" | "UPDATE" | "DELETE" | "NONE";
    text?: string;
    oldId?: string;
    factIndex: number;
};

export type DecisionResult = {
    actions: MemoryAction[];
};

export type DecisionSummary = {
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
};

/**
 * Mem0-style two-stage memory decision:
 * 1. For each extracted fact, vector-recall top-K old memories
 * 2. Map real IDs to short IDs (prevent LLM hallucination)
 * 3. LLM decides ADD/UPDATE/DELETE/NONE
 * 4. Map back to real IDs, execute CRUD
 */
export async function executeMemoryDecision(
    dbPath: string,
    tableName: string,
    newFacts: { content: string; extraFields: Record<string, unknown> }[],
    channel: string,
    api: any,
    embedCfg: EmbedConfig,
    llmCfg: LlmConfig,
): Promise<DecisionSummary> {
    if (newFacts.length === 0) return { added: 0, updated: 0, deleted: 0, unchanged: 0 };

    // Stage 1: Vector recall old memory candidates for all facts
    const allOldMemories = new Map<string, LanceDbRow>();

    for (const fact of newFacts) {
        try {
            const candidates = await vectorSearch(
                dbPath, tableName, fact.content, embedCfg, VECTOR_RECALL_TOP_K,
            );
            for (const row of candidates) {
                const id = String(row.id ?? "");
                if (id && id !== "__seed__") {
                    allOldMemories.set(id, row);
                }
            }
        } catch {
            // Skip if table empty or search fails
        }
    }

    // Stage 2: Create short ID mapping (Mem0 UUID protection)
    const uniqueOldMemories = Array.from(allOldMemories.values());
    const realIdToShort = new Map<string, string>();
    const shortToRealId = new Map<string, string>();

    uniqueOldMemories.forEach((row, i) => {
        const realId = String(row.id);
        const shortId = String(i);
        realIdToShort.set(realId, shortId);
        shortToRealId.set(shortId, realId);
    });

    const oldCandidates: OldMemoryCandidate[] = uniqueOldMemories.map((row) => ({
        shortId: realIdToShort.get(String(row.id))!,
        content: String(row.content ?? row.summary ?? ""),
    }));

    // Stage 3: LLM decision
    const factTexts = newFacts.map((f) => f.content);
    const messages = buildMemoryDecisionMessages(factTexts, oldCandidates);
    const { data: decision } = await chatCompletionJson<DecisionResult>(messages, llmCfg, { temperature: 0.1, stepName: `LLM决策:${tableName}` });

    // Stage 4: Execute actions
    const summary: DecisionSummary = { added: 0, updated: 0, deleted: 0, unchanged: 0 };
    const now = new Date().toISOString();
    const credibility = getCredibility(api, channel);

    for (const action of decision.actions) {
        const factIdx = action.factIndex;
        const factData = newFacts[factIdx];

        try {
            switch (action.event) {
                case "ADD": {
                    const text = action.text ?? factData?.content ?? "";
                    const vector = await generateEmbedding(text, embedCfg);
                    const id = generateId();
                    await addRecords(dbPath, tableName, [{
                        id,
                        content: text,
                        vector,
                        channel,
                        credibility,
                        evidence: 1,
                        createdAt: now,
                        updatedAt: now,
                        ...(factData?.extraFields ?? {}),
                    }]);
                    summary.added++;
                    break;
                }
                case "UPDATE": {
                    const realId = shortToRealId.get(action.oldId ?? "");
                    if (!realId) break;
                    const text = action.text ?? factData?.content ?? "";
                    const vector = await generateEmbedding(text, embedCfg);
                    const oldRow = allOldMemories.get(realId);
                    const oldEvidence = Number(oldRow?.evidence ?? 1);
                    await updateRecord(dbPath, tableName, realId, {
                        content: text,
                        vector,
                        evidence: oldEvidence + 1,
                        updatedAt: now,
                        ...(factData?.extraFields ?? {}),
                    });
                    summary.updated++;
                    break;
                }
                case "DELETE": {
                    const realId = shortToRealId.get(action.oldId ?? "");
                    if (!realId) break;
                    await deleteRecord(dbPath, tableName, realId);
                    summary.deleted++;
                    break;
                }
                case "NONE":
                    summary.unchanged++;
                    break;
            }
        } catch (err) {
            api.logger?.warn?.(`Memory decision action failed: ${action.event} — ${String(err)}`);
        }
    }

    return summary;
}

function generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
