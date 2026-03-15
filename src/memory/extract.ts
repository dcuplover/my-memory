import { chatCompletionJson, type LlmConfig } from "../llm/client";
import { buildDistillationMessages, buildClassificationMessages } from "../llm/prompts";

export type ExtractedAttitude = {
    subject: string;
    attitude: string;
    content: string;
};

export type ExtractedFact = {
    subject: string;
    definition: string;
    content: string;
};

export type ExtractedKnowledge = {
    scenario: string;
    action: string;
    content: string;
};

export type ExtractedPreference = {
    scenario: string;
    options: string;
    preferred: string;
    content: string;
};

export type ExtractionResult = {
    attitudes: ExtractedAttitude[];
    facts: ExtractedFact[];
    knowledge: ExtractedKnowledge[];
    preferences: ExtractedPreference[];
};

/**
 * Extract four types of memories from input text using two-step LLM calls:
 * Step 1: Distillation (distillCfg) — raw text → atomic statements
 * Step 2: Classification (classifyCfg) — statements → four memory layers
 */
export async function extractMemories(
    inputText: string,
    classifyCfg: LlmConfig,
    distillCfg?: LlmConfig,
): Promise<ExtractionResult> {
    // Step 1: Distillation
    const distillMessages = buildDistillationMessages(inputText);
    const { data: statements } = await chatCompletionJson<string[]>(distillMessages, distillCfg ?? classifyCfg, {
        temperature: 0.2,
        maxTokens: 4000,
        stepName: "LLM信息蒸馏",
    });

    const validStatements = Array.isArray(statements) ? statements.filter((s) => typeof s === "string" && s.trim()) : [];
    if (validStatements.length === 0) {
        return { attitudes: [], facts: [], knowledge: [], preferences: [] };
    }

    // Step 2: Classification
    const classifyMessages = buildClassificationMessages(validStatements);
    const { data: result } = await chatCompletionJson<ExtractionResult>(classifyMessages, classifyCfg, {
        temperature: 0.2,
        maxTokens: 4000,
        stepName: "LLM记忆分类",
    });

    return {
        attitudes: Array.isArray(result.attitudes) ? result.attitudes : [],
        facts: Array.isArray(result.facts) ? result.facts : [],
        knowledge: Array.isArray(result.knowledge) ? result.knowledge : [],
        preferences: Array.isArray(result.preferences) ? result.preferences : [],
    };
}
