/**
 * url.ts — 从 URL 抓取网页内容并提取干净文本
 *
 * 使用 Readability 算法提取文章正文，配合 linkedom 做 DOM 解析。
 * 返回标题 + 干净的 Markdown 风格文本。
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

// ─── 安全限制 ───

/** 最大 HTML 下载字节数 (5 MB) */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** fetch 超时 (30 秒) */
const FETCH_TIMEOUT_MS = 30_000;

export type FetchUrlResult = {
    /** 文章标题 */
    title: string;
    /** 文章纯文本内容 */
    content: string;
    /** 原始 URL */
    url: string;
    /** 内容长度（字符） */
    length: number;
};

/**
 * 抓取 URL 并提取文章正文。
 * 使用 @mozilla/readability 做主要内容提取。
 */
export async function fetchUrl(url: string): Promise<FetchUrlResult> {
    // 基本 URL 校验
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        throw new Error(`无效的 URL: ${url}`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`不支持的协议: ${parsedUrl.protocol}，仅支持 http/https`);
    }

    // 抓取页面
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; MyMemoryBot/1.0)",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            signal: controller.signal,
            redirect: "follow",
        });
    } catch (err: any) {
        if (err?.name === "AbortError") {
            throw new Error(`URL 抓取超时 (${FETCH_TIMEOUT_MS / 1000}s): ${url}`);
        }
        throw new Error(`URL 抓取失败: ${err?.message ?? err}`);
    } finally {
        clearTimeout(timeout);
    }

    if (!resp.ok) {
        throw new Error(`URL 返回 HTTP ${resp.status}: ${url}`);
    }

    // 检查内容类型
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        throw new Error(`URL 内容类型不是 HTML: ${contentType}`);
    }

    // 读取 HTML（带大小限制）
    const html = await readResponseWithLimit(resp, MAX_HTML_BYTES);

    // 使用 linkedom + Readability 提取正文
    const { document } = parseHTML(html);
    const reader = new Readability(document as any);
    const article = reader.parse();

    if (!article || !article.textContent?.trim()) {
        // Readability 提取失败，回退到基础 HTML 清洗
        const fallbackText = fallbackExtract(html);
        if (!fallbackText.trim()) {
            throw new Error(`无法从 URL 提取有效内容: ${url}`);
        }
        return {
            title: extractTitleFromHtml(html) || parsedUrl.hostname,
            content: fallbackText,
            url,
            length: fallbackText.length,
        };
    }

    // 清理文本
    const cleanContent = cleanText(article.textContent);

    return {
        title: article.title || parsedUrl.hostname,
        content: cleanContent,
        url,
        length: cleanContent.length,
    };
}

// ─── 辅助函数 ───

/** 带大小限制地读取 Response body */
async function readResponseWithLimit(resp: Response, maxBytes: number): Promise<string> {
    const reader = resp.body?.getReader();
    if (!reader) {
        return resp.text();
    }

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            reader.cancel();
            throw new Error(`HTML 内容过大，超过 ${maxBytes / 1024 / 1024} MB 限制`);
        }

        chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join("");
}

/** 从 HTML 中提取 title 标签内容（回退用） */
function extractTitleFromHtml(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match?.[1]?.trim();
}

/** 回退：基础 HTML → 文本提取（当 Readability 失败时） */
function fallbackExtract(html: string): string {
    let text = html;
    // 移除 script 和 style
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
    text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
    // 移除所有标签
    text = text.replace(/<[^>]+>/g, " ");
    // 解码 HTML 实体
    text = decodeHtmlEntities(text);
    return cleanText(text);
}

/** 基础 HTML 实体解码 */
function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
}

/** 清理文本：合并空白行、去除多余空格 */
function cleanText(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+/g, " ")         // 多个空格/tab → 单空格
        .replace(/\n{3,}/g, "\n\n")      // 3+ 空行 → 2 空行
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim();
}
