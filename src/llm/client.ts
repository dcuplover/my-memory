export type LlmConfig = {
    baseUrl: string;
    model: string;
    apiKey: string;
};

export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

/**
 * Call OpenAI-compatible chat completion API.
 * Returns the assistant message content.
 */
export async function chatCompletion(
    messages: ChatMessage[],
    cfg: LlmConfig,
    options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
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
    };
    return json.choices[0]?.message?.content ?? "";
}

/**
 * Call LLM and parse JSON response.
 */
export async function chatCompletionJson<T>(
    messages: ChatMessage[],
    cfg: LlmConfig,
    options?: { temperature?: number; maxTokens?: number },
): Promise<T> {
    const raw = await chatCompletion(messages, cfg, options);

    // Extract JSON from possible markdown code fence
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const jsonStr = (jsonMatch[1] ?? raw).trim();

    try {
        return JSON.parse(jsonStr) as T;
    } catch {
        throw new Error(`Failed to parse LLM JSON response: ${raw.slice(0, 500)}`);
    }
}
