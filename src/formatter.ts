import type { SearchResult } from "./search/hybrid";

/**
 * Format search results into a context string for prependContext injection.
 * Results are sorted by credibility descending.
 */
export function formatMemoryResults(results: SearchResult[], layerLabel: string): string | undefined {
    if (results.length === 0) return undefined;

    // Sort by finalScore descending (已在 query.ts 中计算, 此处保底排序)
    const sorted = [...results].sort((a, b) => {
        const scoreA = Number(a._finalScore ?? a._score ?? 0);
        const scoreB = Number(b._finalScore ?? b._score ?? 0);
        return scoreB - scoreA;
    });

    const lines = sorted.map((row, i) => {
        const parts: string[] = [];
        if (row.content) parts.push(`内容: ${truncate(String(row.content), 300)}`);
        if (row.summary) parts.push(`摘要: ${truncate(String(row.summary), 300)}`);
        if (row.subject) parts.push(`主题: ${String(row.subject)}`);
        if (row.attitude) parts.push(`态度: ${String(row.attitude)}`);
        if (row.definition) parts.push(`定义: ${String(row.definition)}`);
        if (row.scenario) parts.push(`情景: ${String(row.scenario)}`);
        if (row.action) parts.push(`行动: ${String(row.action)}`);
        if (row.preferred) parts.push(`偏好: ${String(row.preferred)}`);
        if (row.options) parts.push(`选项: ${String(row.options)}`);
        const cred = Number(row.credibility ?? 0).toFixed(2);
        parts.push(`可信度: ${cred}`);
        if (row._finalScore != null) parts.push(`得分: ${Number(row._finalScore).toFixed(2)}`);
        return `${i + 1}. ${parts.join(" | ")}`;
    });

    return [`[${layerLabel}]`, ...lines].join("\n");
}

/**
 * Format file layer summary (not full results, just count).
 */
export function formatFileSummary(tableName: string, count: number, layerLabel: string): string | undefined {
    if (count === 0) return undefined;
    return `[${layerLabel}] 共有 ${count} 条相关记录，如需详细内容请直接查询。`;
}

/**
 * Assemble all layer results into final prependContext string.
 */
export function assembleContext(sections: (string | undefined)[]): string | undefined {
    const valid = sections.filter((s): s is string => !!s);
    if (valid.length === 0) return undefined;
    return [
        "以下是从记忆系统中检索到的相关信息，请仅在与用户问题直接相关时参考使用：",
        "",
        ...valid,
    ].join("\n");
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}
