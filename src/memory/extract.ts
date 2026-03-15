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
    console.log(`[记忆提取] Step 1: 信息蒸馏开始 (输入${inputText.length}字符)`);
    const distillMessages = buildDistillationMessages(inputText);
    const { data: statements } = await chatCompletionJson<string[]>(distillMessages, distillCfg ?? classifyCfg, {
        temperature: 0.2,
        maxTokens: 16384,
        stepName: "LLM信息蒸馏",
    });

    const validStatements = Array.isArray(statements) ? statements.filter((s) => typeof s === "string" && s.trim()) : [];
    console.log(`[记忆提取] Step 1 完成: 蒸馏出 ${validStatements.length} 条陈述`, validStatements);
    if (validStatements.length === 0) {
        console.log(`[记忆提取] 蒸馏结果为空，跳过分类`);
        return { attitudes: [], facts: [], knowledge: [], preferences: [] };
    }

    // Step 2: Classification
    console.log(`[记忆提取] Step 2: 分类归档开始 (${validStatements.length}条陈述)`);
    const classifyMessages = buildClassificationMessages(validStatements);
    const { data: result } = await chatCompletionJson<ExtractionResult>(classifyMessages, classifyCfg, {
        temperature: 0.2,
        maxTokens: 16384,
        stepName: "LLM记忆分类",
    });

    const final = {
        attitudes: Array.isArray(result.attitudes) ? result.attitudes : [],
        facts: Array.isArray(result.facts) ? result.facts : [],
        knowledge: Array.isArray(result.knowledge) ? result.knowledge : [],
        preferences: Array.isArray(result.preferences) ? result.preferences : [],
    };
    console.log(`[记忆提取] Step 2 完成: 态度${final.attitudes.length} 事实${final.facts.length} 知识${final.knowledge.length} 偏好${final.preferences.length}`);
    return final;
}
