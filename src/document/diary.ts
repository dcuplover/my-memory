import { splitIntoChunks } from "./chunker";
import { generateEmbeddings, type EmbedConfig } from "../embedding";
import { addRecords } from "../db/crud";
import { ensureTable } from "../db/schema";
import { TABLE_NAMES, getPluginConfig, getLanceDbPath, getEmbedConfig, getCredibility, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP, DEFAULT_EMBED_DIMENSIONS } from "../config";

/**
 * Process a diary entry:
 * 1. Split full text into overlapping chunks (sliding window)
 * 2. Generate embeddings for each chunk
 * 3. Batch-write to file_diary table
 */
export async function addDiary(
    api: any,
    content: string,
    title: string,
    date: string,
    channel: string = "diary",
): Promise<{ chunksAdded: number }> {
    const dbPath = getLanceDbPath(api);
    if (!dbPath) throw new Error("LanceDB path not configured");

    const cfg = getPluginConfig(api);
    const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
    if (!embedCfg) throw new Error("Embedding config missing");

    const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;
    const chunkSize = cfg.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = cfg.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

    // Ensure table exists
    await ensureTable(dbPath, TABLE_NAMES.DIARY, dims);

    // Step 1: Chunk the text
    const chunks = splitIntoChunks(content, chunkSize, chunkOverlap);
    if (chunks.length === 0) return { chunksAdded: 0 };

    // Step 2: Batch embed
    const texts = chunks.map((c) => c.text);
    const embeddings = await generateEmbeddings(texts, embedCfg);

    // Step 3: Build records and insert
    const sourceId = `diary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const credibility = getCredibility(api, channel);

    const records = chunks.map((chunk, i) => ({
        id: `${sourceId}_${chunk.index}`,
        content: chunk.text,
        title,
        date,
        chunk_index: chunk.index,
        source_id: sourceId,
        vector: embeddings[i],
        channel,
        credibility,
        createdAt: now,
    }));

    await addRecords(dbPath, TABLE_NAMES.DIARY, records, dims);

    return { chunksAdded: records.length };
}
