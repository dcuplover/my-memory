/**
 * summarize.ts — 深度文章总结（Map-Reduce 策略）
 *
 * 对短文直接总结，对长文分段总结后合并。
 * 设计目标：不丢失文章核心信息（数据、论点、因果关系）。
 */
import { chatCompletion, type LlmConfig } from "../llm/client";
import { buildDeepSummaryMessages, buildMergeSummaryMessages } from "../llm/prompts";
import { splitIntoChunks } from "./chunker";
import { DEFAULT_EXTRACT_CHUNK_SIZE } from "../config";

/** 分段总结的 chunk 重叠字符数 */
const SUMMARY_CHUNK_OVERLAP = 200;

export type SummarizeOptions = {
    /** 文章标题（可选，帮助 LLM 理解上下文） */
    title?: string;
    /** 分段大小（字符数），默认使用 extractChunkSize */
    chunkSize?: number;
};

export type SummarizeResult = {
    /** 深度总结文本（Markdown 格式） */
    summary: string;
    /** 是否使用了分段合并策略 */
    usedMapReduce: boolean;
    /** 分段数（如果使用了 map-reduce） */
    chunkCount: number;
};

/**
 * 对文章进行深度总结。
 *
 * - 短文（<= chunkSize）：直接调用 LLM 做深度总结
 * - 长文（> chunkSize）：Map-Reduce 策略
 *   1. Map: 每段独立提取要点
 *   2. Reduce: 合并所有段落要点为完整总结
 */
export async function deepSummarize(
    content: string,
    llmCfg: LlmConfig,
    options: SummarizeOptions = {},
): Promise<SummarizeResult> {
    const chunkSize = options.chunkSize ?? DEFAULT_EXTRACT_CHUNK_SIZE;

    if (content.length <= chunkSize) {
        // 短文：直接深度总结
        const messages = buildDeepSummaryMessages(content, options.title);
        const { content: summary } = await chatCompletion(messages, llmCfg, {
            temperature: 0.3,
            maxTokens: 4096,
            stepName: "深度总结",
        });

        return { summary, usedMapReduce: false, chunkCount: 1 };
    }

    // 长文：Map-Reduce
    const chunks = splitIntoChunks(content, chunkSize, SUMMARY_CHUNK_OVERLAP);
    const chunkSummaries: string[] = [];

    // Map 阶段：每段提取要点
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const messages = buildDeepSummaryMessages(
            chunk.text,
            options.title,
            { partIndex: i + 1, totalParts: chunks.length },
        );
        const { content: chunkSummary } = await chatCompletion(messages, llmCfg, {
            temperature: 0.3,
            maxTokens: 2048,
            stepName: `分段总结(${i + 1}/${chunks.length})`,
        });
        chunkSummaries.push(chunkSummary);
    }

    // Reduce 阶段：合并所有段落要点
    const mergeMessages = buildMergeSummaryMessages(chunkSummaries, options.title);
    const { content: finalSummary } = await chatCompletion(mergeMessages, llmCfg, {
        temperature: 0.3,
        maxTokens: 4096,
        stepName: "合并总结",
    });

    return {
        summary: finalSummary,
        usedMapReduce: true,
        chunkCount: chunks.length,
    };
}
