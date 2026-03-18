import { chatCompletionJson, type LlmConfig } from "../llm/client";
import { buildTripleExtractionMessages } from "../llm/prompts";
import { storeTriples, type Triple } from "./operations";

/**
 * Extract entity relationship triples from distilled statements and store in graph.
 * Uses the raw distilled statements (Step 1 output) instead of classified memories
 * to preserve richer context for relationship extraction.
 */
export async function extractAndStoreTriples(
    kuzuDbPath: string,
    statements: string[],
    llmCfg: LlmConfig,
): Promise<{ extracted: number; stored: number }> {
    if (statements.length === 0) return { extracted: 0, stored: 0 };

    // LLM extraction directly from distilled statements
    const messages = buildTripleExtractionMessages(statements);
    const { data } = await chatCompletionJson<{ triples: Triple[] }>(messages, llmCfg, {
        temperature: 0.1,
        maxTokens: 4096,
        stepName: "图谱三元组提取",
    });

    const triples = Array.isArray(data?.triples)
        ? data.triples.filter(
            (t: any) => typeof t?.subject === "string" && typeof t?.predicate === "string" && typeof t?.object === "string"
                && t.subject.trim() && t.predicate.trim() && t.object.trim()
        )
        : [];

    if (triples.length === 0) return { extracted: 0, stored: 0 };

    // Store in graph
    const stored = await storeTriples(kuzuDbPath, triples);

    return { extracted: triples.length, stored };
}
