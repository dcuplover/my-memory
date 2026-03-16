import { generateEmbedding, type EmbedConfig } from "../embedding";
import { chatCompletion, type LlmConfig } from "../llm/client";
import { buildDocumentSummaryMessages } from "../llm/prompts";
import { addRecords } from "../db/crud";
import { ensureTable } from "../db/schema";
import { TABLE_NAMES, getPluginConfig, getLanceDbPath, getEmbedConfig, getLlmConfig, getCredibility, DEFAULT_EMBED_DIMENSIONS, MAX_CONTENT_JOIN_CHARS } from "../config";

/**
 * Process a document for the file library:
 * 1. Generate summary via LLM
 * 2. Embed the summary
 * 3. Write to file_document table (preserve file_path)
 */
export async function addDocument(
    api: any,
    content: string,
    filePath: string,
    title: string,
    docType: string = "document",
    channel: string = "document",
): Promise<{ summary: string }> {
    const dbPath = getLanceDbPath(api);
    if (!dbPath) throw new Error("LanceDB path not configured");

    const cfg = getPluginConfig(api);
    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    const llmCfg = getLlmConfig(api) as LlmConfig | undefined;
    if (!embedCfg || !llmCfg) throw new Error("Embedding or LLM config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;

    // Ensure table exists
    await ensureTable(dbPath, TABLE_NAMES.DOCUMENT, dims);

    // Step 1: Generate summary (cap content to prevent huge LLM payloads)
    const cappedContent = content.length > MAX_CONTENT_JOIN_CHARS
        ? content.slice(0, MAX_CONTENT_JOIN_CHARS) + `\n[...截断：内容超过 ${MAX_CONTENT_JOIN_CHARS} 字符]`
        : content;
    const messages = buildDocumentSummaryMessages(cappedContent, title);
    const { content: summary } = await chatCompletion(messages, llmCfg, { temperature: 0.3, maxTokens: 1000 });

    // Step 2: Embed the summary
    const vector = await generateEmbedding(summary, embedCfg);

    // Step 3: Write record
    const now = new Date().toISOString();
    const id = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const credibility = getCredibility(api, channel);

    await addRecords(dbPath, TABLE_NAMES.DOCUMENT, [{
        id,
        summary,
        title,
        file_path: filePath,
        doc_type: docType,
        vector,
        channel,
        credibility,
        createdAt: now,
    }], dims);

    return { summary };
}
