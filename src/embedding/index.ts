import { getEmbedConfig } from "../config";

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

    const json = (await resp.json()) as { data: { embedding: number[] }[] };
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

    const json = (await resp.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function getEmbedConfigFromApi(api: any): EmbedConfig | undefined {
    return getEmbedConfig(api) as EmbedConfig | undefined;
}
