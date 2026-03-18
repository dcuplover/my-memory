import { chatCompletionJson, type LlmConfig } from "../llm/client";
import { buildTripleExtractionMessages } from "../llm/prompts";
import { storeTriples, type Triple } from "./operations";
import type { ExtractionResult } from "../memory/extract";

/**
 * Extract entity relationship triples from classified memories and store in graph.
 */
export async function extractAndStoreTriples(
    kuzuDbPath: string,
    extraction: ExtractionResult,
    llmCfg: LlmConfig,
): Promise<{ extracted: number; stored: number }> {
    // Build input for triple extraction
    const items: string[] = [];

    for (const a of extraction.attitudes) {
        items.push(`[态度] 主题: ${a.subject} | 态度: ${a.attitude} | ${a.content}`);
    }
    for (const f of extraction.facts) {
        items.push(`[事实] 主题: ${f.subject} | 定义: ${f.definition} | ${f.content}`);
    }
    for (const k of extraction.knowledge) {
        items.push(`[知识] 情景: ${k.scenario} | 行动: ${k.action} | ${k.content}`);
    }
    for (const p of extraction.preferences) {
        items.push(`[偏好] 情景: ${p.scenario} | 选项: ${p.options} | 倾向: ${p.preferred} | ${p.content}`);
    }

    if (items.length === 0) return { extracted: 0, stored: 0 };

    // LLM extraction
    const messages = buildTripleExtractionMessages(items);
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
