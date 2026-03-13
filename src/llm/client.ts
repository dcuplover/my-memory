import { currentTracker, type TokenUsage } from "../tracker";

export type LlmConfig = {
    baseUrl: string;
    model: string;
    apiKey: string;
};

export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

export type LlmResult = {
    content: string;
    usage: TokenUsage;
};

/**
 * Call OpenAI-compatible chat completion API.
 * Returns content + token usage.
 */
export async function chatCompletion(
    messages: ChatMessage[],
    cfg: LlmConfig,
    options?: { temperature?: number; maxTokens?: number; stepName?: string },
): Promise<LlmResult> {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: options?.temperature ?? 0.3,
            max_tokens: options?.maxTokens ?? 2000,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`LLM API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const content = json.choices[0]?.message?.content ?? "";
    const usage: TokenUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
    };

    const stepName = options?.stepName ?? "llm_call";
    currentTracker()?.addTokens(stepName, usage);

    return { content, usage };
}

/**
 * Call LLM and parse JSON response. Returns parsed data + token usage.
 */
export async function chatCompletionJson<T>(
    messages: ChatMessage[],
    cfg: LlmConfig,
    options?: { temperature?: number; maxTokens?: number; stepName?: string },
): Promise<{ data: T; usage: TokenUsage }> {
    const result = await chatCompletion(messages, cfg, options);

    // Extract JSON from possible markdown code fence
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, result.content];
    const jsonStr = (jsonMatch[1] ?? result.content).trim();

    try {
        const data = JSON.parse(jsonStr) as T;
        return { data, usage: result.usage };
    } catch {
        throw new Error(`Failed to parse LLM JSON response: ${result.content.slice(0, 500)}`);
    }
}
