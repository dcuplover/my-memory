export type RerankConfig = {
    baseUrl: string;
    model: string;
    apiKey: string;
};

export type RerankResult = {
    index: number;
    relevance_score: number;
};

/**
 * Call external Rerank API (Cohere/Jina compatible) to rerank documents.
 * Returns indices of top results sorted by relevance.
 */
export async function rerankDocuments(
    query: string,
    documents: string[],
    cfg: RerankConfig,
    topN: number,
): Promise<RerankResult[]> {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/rerank`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            model: cfg.model,
            query,
            documents,
            top_n: topN,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Rerank API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as { results: RerankResult[] };
    return json.results.sort((a, b) => b.relevance_score - a.relevance_score);
}
