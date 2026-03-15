import { currentTracker, type TokenUsage } from "../tracker";

export type LlmConfig = {
    baseUrl: string;
    model: string;
    apiKey: string;
    enableThinking?: boolean;
    timeoutMs?: number;
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
    options?: { temperature?: number; maxTokens?: number; stepName?: string; timeoutMs?: number },
): Promise<LlmResult> {
    const stepName = options?.stepName ?? "llm_call";
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    console.log(`[${stepName}] 请求 ${cfg.model} (${url})`);

    const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs ?? 300_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({
                model: cfg.model,
                messages,
                temperature: options?.temperature ?? 0.3,
                max_tokens: options?.maxTokens ?? 8192,
                ...(cfg.enableThinking === false ? { enable_thinking: false } : {}),
            }),
            signal: controller.signal,
        });
    } catch (err: any) {
        clearTimeout(timeout);
        if (err?.name === "AbortError") {
            throw new Error(`[${stepName}] LLM 请求超时 (${Math.round(timeoutMs / 1000)}s)`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`LLM API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const content = json.choices[0]?.message?.content ?? "";
    console.log(`[${stepName}] LLM 原始返回 (${content.length}字符): ${content.slice(0, 500)}${content.length > 500 ? "..." : ""}`);
    const usage: TokenUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
    };

    currentTracker()?.addTokens(stepName, usage);

    return { content, usage };
}

/**
 * Call LLM and parse JSON response. Returns parsed data + token usage.
 */
export async function chatCompletionJson<T>(
    messages: ChatMessage[],
    cfg: LlmConfig,
    options?: { temperature?: number; maxTokens?: number; stepName?: string; timeoutMs?: number },
): Promise<{ data: T; usage: TokenUsage }> {
    const result = await chatCompletion(messages, cfg, options);
    const stepName = options?.stepName ?? "llm_call";

    // Strip thinking blocks (e.g. Qwen3 <think>...</think>)
    let text = result.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text.length !== result.content.length) {
        console.log(`[${stepName}] 已剥离 <think> 块，剩余内容 (${text.length}字符): ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
    }

    // Extract JSON from possible markdown code fence
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const jsonStr = (jsonMatch[1] ?? text).trim();
    if (jsonMatch[0]) {
        console.log(`[${stepName}] 从代码围栏提取 JSON (${jsonStr.length}字符)`);
    }

    try {
        const data = JSON.parse(jsonStr) as T;
        console.log(`[${stepName}] JSON 解析成功`);
        return { data, usage: result.usage };
    } catch (e) {
        console.error(`[${stepName}] JSON 解析失败，待解析内容: ${jsonStr.slice(0, 500)}`);
        throw new Error(`Failed to parse LLM JSON response: ${result.content.slice(0, 500)}`);
    }
}
