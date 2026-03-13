export type Chunk = {
    text: string;
    index: number;
};

/**
 * Split text into overlapping chunks using a sliding window approach.
 *
 * @param text - Full text to split
 * @param chunkSize - Maximum characters per chunk (default 512)
 * @param overlap - Overlap characters between consecutive chunks (default 128)
 */
export function splitIntoChunks(
    text: string,
    chunkSize: number = 512,
    overlap: number = 128,
): Chunk[] {
    if (!text || text.length === 0) return [];
    if (text.length <= chunkSize) {
        return [{ text, index: 0 }];
    }

    const chunks: Chunk[] = [];
    let start = 0;
    let index = 0;
    const step = chunkSize - overlap;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const chunk = text.slice(start, end);

        if (chunk.trim().length > 0) {
            chunks.push({ text: chunk, index });
            index++;
        }

        if (end >= text.length) break;
        start += step;
    }

    return chunks;
}
