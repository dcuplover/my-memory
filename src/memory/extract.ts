import { chatCompletionJson, type LlmConfig } from "../llm/client";
import { buildMemoryExtractionMessages } from "../llm/prompts";

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
 * Extract four types of memories from input text using LLM.
 */
export async function extractMemories(
    inputText: string,
    llmCfg: LlmConfig,
): Promise<ExtractionResult> {
    const messages = buildMemoryExtractionMessages(inputText);
    const result = await chatCompletionJson<ExtractionResult>(messages, llmCfg, {
        temperature: 0.2,
        maxTokens: 4000,
    });

    // Validate structure
    return {
        attitudes: Array.isArray(result.attitudes) ? result.attitudes : [],
        facts: Array.isArray(result.facts) ? result.facts : [],
        knowledge: Array.isArray(result.knowledge) ? result.knowledge : [],
        preferences: Array.isArray(result.preferences) ? result.preferences : [],
    };
}
