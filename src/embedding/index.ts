import { getEmbedConfig } from "../config";
import { currentTracker, type TokenUsage } from "../tracker";

export type EmbedConfig = {
    baseUrl: string;
    model: string;
    apiKey: string;
    dimensions: number;
};

export async function generateEmbedding(text: string, cfg: EmbedConfig): Promise<number[]> {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            input: text,
            model: cfg.model,
            dimensions: cfg.dimensions,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Embedding API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as {
        data: { embedding: number[] }[];
        usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    const usage: TokenUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: 0,
        totalTokens: json.usage?.total_tokens ?? 0,
    };
    currentTracker()?.addTokens("embedding", usage);

    return json.data[0].embedding;
}

export async function generateEmbeddings(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await generateEmbedding(texts[0], cfg)];

    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            input: texts,
            model: cfg.model,
            dimensions: cfg.dimensions,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Embedding API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as {
        data: { embedding: number[]; index: number }[];
        usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    const usage: TokenUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: 0,
        totalTokens: json.usage?.total_tokens ?? 0,
    };
    currentTracker()?.addTokens("embedding_batch", usage);

    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function getEmbedConfigFromApi(api: any): EmbedConfig | undefined {
    return getEmbedConfig(api) as EmbedConfig | undefined;
}
