import { queryMemory } from "./src/memory/query";
import { addMemory, formatAddResult } from "./src/memory/add";
import { addDiary } from "./src/document/diary";
import { addDocument } from "./src/document/file";
import { ensureAllTables } from "./src/db/schema";
import { search, type SearchMode } from "./src/search/hybrid";
import { formatMemoryResults } from "./src/formatter";
import {
    getLanceDbPath,
    getPluginConfig,
    getEmbedConfig,
    getRerankConfig,
    DEFAULT_RESULT_LIMIT,
    DEFAULT_TOP_K,
    DEFAULT_EMBED_DIMENSIONS,
    TABLE_NAMES,
} from "./src/config";
import { LAYER_DESCRIPTIONS, FileLayer, getTableForFileLayer } from "./src/memory/layers";
import type { EmbedConfig } from "./src/embedding";
import type { RerankConfig } from "./src/search/reranker";

export default function (api: any) {

    // ═══════════════════════════════════════════════════════════
    // 1. before_prompt_build — 自动记忆查询与上下文注入
    // ═══════════════════════════════════════════════════════════

    api.on("before_prompt_build", async (event: { prompt: string }, ctx: { trigger?: string }) => {
        if (ctx?.trigger && ctx.trigger !== "user") return;

        try {
            const context = await queryMemory(api, event.prompt);
            if (!context) return;
            return { prependContext: context };
        } catch (err) {
            api.logger?.warn?.(`Memory query error: ${String(err)}`);
            return;
        }
    });

    // ═══════════════════════════════════════════════════════════
    // 2. Slash Commands
    // ═══════════════════════════════════════════════════════════

    // /add_memory — 添加记忆（从文本中提取四层记忆）
    api.registerCommand({
        name: "add_memory",
        description: "从文本中提取并添加记忆（态度/事实/知识/偏好）",
        async handler(ctx: any) {
            try {
                const text = ctx.prompt?.trim() || ctx.args?.trim();
                if (!text) return { text: "请提供要提取记忆的文本内容。" };

                const channel = ctx.channel || "user_input";
                const result = await addMemory(api, text, channel);
                return { text: formatAddResult(result) };
            } catch (err) {
                return { text: `添加记忆失败: ${String(err)}` };
            }
        },
    });

    // /add_diary — 添加日记
    api.registerCommand({
        name: "add_diary",
        description: "添加日记到日记本（全文切分+向量化索引）",
        async handler(ctx: any) {
            try {
                const text = ctx.prompt?.trim() || ctx.args?.trim();
                if (!text) return { text: "请提供日记内容。" };

                const title = ctx.title || `日记 ${new Date().toLocaleDateString("zh-CN")}`;
                const date = ctx.date || new Date().toISOString().slice(0, 10);
                const result = await addDiary(api, text, title, date);
                return { text: `日记处理完成：共切分为 ${result.chunksAdded} 个片段并已索引。` };
            } catch (err) {
                return { text: `添加日记失败: ${String(err)}` };
            }
        },
    });

    // /add_document — 添加文档到文件库
    api.registerCommand({
        name: "add_document",
        description: "添加文档到文件库（生成摘要+向量化索引）",
        async handler(ctx: any) {
            try {
                const content = ctx.prompt?.trim() || ctx.args?.trim();
                if (!content) return { text: "请提供文档内容或文件路径。" };

                const filePath = ctx.filePath || ctx.file_path || "unknown";
                const title = ctx.title || "未命名文档";
                const result = await addDocument(api, content, filePath, title);
                return { text: `文档处理完成。\n摘要：${result.summary.slice(0, 200)}...` };
            } catch (err) {
                return { text: `添加文档失败: ${String(err)}` };
            }
        },
    });

    // /query_diary — 直接查询日记本
    api.registerCommand({
        name: "query_diary",
        description: "直接查询日记本层",
        async handler(ctx: any) {
            try {
                const query = ctx.prompt?.trim() || ctx.args?.trim();
                if (!query) return { text: "请提供查询关键词。" };

                const dbPath = getLanceDbPath(api);
                if (!dbPath) return { text: "LanceDB 未配置。" };

                const cfg = getPluginConfig(api);
                const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
                const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;
                if (!embedCfg) return { text: "Embedding 未配置。" };

                const results = await search({
                    dbPath,
                    tableName: TABLE_NAMES.DIARY,
                    query,
                    mode: "hybrid" as SearchMode,
                    limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
                    topK: cfg.topK ?? DEFAULT_TOP_K,
                    embedCfg,
                    rerankCfg,
                });

                const formatted = formatMemoryResults(results, LAYER_DESCRIPTIONS[FileLayer.Diary]);
                return { text: formatted || "未找到相关日记内容。" };
            } catch (err) {
                return { text: `查询日记失败: ${String(err)}` };
            }
        },
    });

    // /query_document — 直接查询文件库
    api.registerCommand({
        name: "query_document",
        description: "直接查询文件库层",
        async handler(ctx: any) {
            try {
                const query = ctx.prompt?.trim() || ctx.args?.trim();
                if (!query) return { text: "请提供查询关键词。" };

                const dbPath = getLanceDbPath(api);
                if (!dbPath) return { text: "LanceDB 未配置。" };

                const cfg = getPluginConfig(api);
                const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
                const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;
                if (!embedCfg) return { text: "Embedding 未配置。" };

                const results = await search({
                    dbPath,
                    tableName: TABLE_NAMES.DOCUMENT,
                    query,
                    mode: "hybrid" as SearchMode,
                    limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
                    topK: cfg.topK ?? DEFAULT_TOP_K,
                    embedCfg,
                    rerankCfg,
                });

                const formatted = formatMemoryResults(results, LAYER_DESCRIPTIONS[FileLayer.Document]);
                return { text: formatted || "未找到相关文档。" };
            } catch (err) {
                return { text: `查询文件库失败: ${String(err)}` };
            }
        },
    });

    // ═══════════════════════════════════════════════════════════
    // 3. AI Tools (registerTool)
    // ═══════════════════════════════════════════════════════════

    // add_memory tool
    api.registerTool({
        name: "add_memory",
        description: "从文本中提取并添加记忆（态度、事实、客观知识、主观选择四层）。当用户明确要求记住/保存某些信息时调用此工具。",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "要提取记忆的文本内容",
                },
                channel: {
                    type: "string",
                    description: "记忆来源渠道，如 daily_chat、document、verified、user_input",
                },
            },
            required: ["text"],
        },
        async execute(_id: string, params: { text: string; channel?: string }) {
            try {
                const result = await addMemory(api, params.text, params.channel || "daily_chat");
                return { content: [{ type: "text", text: formatAddResult(result) }] };
            } catch (err) {
                return { content: [{ type: "text", text: `添加记忆失败: ${String(err)}` }] };
            }
        },
    });

    // add_diary tool
    api.registerTool({
        name: "add_diary",
        description: "添加日记到日记本层。将整篇日记进行切分、向量化和索引，以便后续通过语义搜索查找。",
        parameters: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "日记全文内容",
                },
                title: {
                    type: "string",
                    description: "日记标题",
                },
                date: {
                    type: "string",
                    description: "日记日期，格式 YYYY-MM-DD",
                },
            },
            required: ["content"],
        },
        async execute(_id: string, params: { content: string; title?: string; date?: string }) {
            try {
                const title = params.title || `日记 ${new Date().toLocaleDateString("zh-CN")}`;
                const date = params.date || new Date().toISOString().slice(0, 10);
                const result = await addDiary(api, params.content, title, date);
                return { content: [{ type: "text", text: `日记已索引：共 ${result.chunksAdded} 个片段。` }] };
            } catch (err) {
                return { content: [{ type: "text", text: `添加日记失败: ${String(err)}` }] };
            }
        },
    });

    // add_document tool
    api.registerTool({
        name: "add_document",
        description: "添加文档到文件库层。对文档生成摘要并向量化索引，保留文件路径以便后续引用。",
        parameters: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "文档内容",
                },
                file_path: {
                    type: "string",
                    description: "文档的文件路径",
                },
                title: {
                    type: "string",
                    description: "文档标题",
                },
            },
            required: ["content"],
        },
        async execute(_id: string, params: { content: string; file_path?: string; title?: string }) {
            try {
                const result = await addDocument(
                    api,
                    params.content,
                    params.file_path || "unknown",
                    params.title || "未命名文档",
                );
                return { content: [{ type: "text", text: `文档已索引。摘要：${result.summary.slice(0, 300)}` }] };
            } catch (err) {
                return { content: [{ type: "text", text: `添加文档失败: ${String(err)}` }] };
            }
        },
    });

    // query_diary tool
    api.registerTool({
        name: "query_diary",
        description: "查询日记本层。当用户提到要搜索日记、查找日记记录时调用。",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "搜索关键词或问题",
                },
            },
            required: ["query"],
        },
        async execute(_id: string, params: { query: string }) {
            try {
                const dbPath = getLanceDbPath(api);
                if (!dbPath) return { content: [{ type: "text", text: "LanceDB 未配置。" }] };

                const cfg = getPluginConfig(api);
                const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
                const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;
                if (!embedCfg) return { content: [{ type: "text", text: "Embedding 未配置。" }] };

                const results = await search({
                    dbPath,
                    tableName: TABLE_NAMES.DIARY,
                    query: params.query,
                    mode: "hybrid",
                    limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
                    topK: cfg.topK ?? DEFAULT_TOP_K,
                    embedCfg,
                    rerankCfg,
                });

                const formatted = formatMemoryResults(results, LAYER_DESCRIPTIONS[FileLayer.Diary]);
                return { content: [{ type: "text", text: formatted || "未找到相关日记。" }] };
            } catch (err) {
                return { content: [{ type: "text", text: `查询日记失败: ${String(err)}` }] };
            }
        },
    });

    // query_document tool
    api.registerTool({
        name: "query_document",
        description: "查询文件库层。当用户提到要搜索文档、查找文件时调用。",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "搜索关键词或问题",
                },
            },
            required: ["query"],
        },
        async execute(_id: string, params: { query: string }) {
            try {
                const dbPath = getLanceDbPath(api);
                if (!dbPath) return { content: [{ type: "text", text: "LanceDB 未配置。" }] };

                const cfg = getPluginConfig(api);
                const embedCfg = getEmbedConfig(api) as EmbedConfig | undefined;
                const rerankCfg = getRerankConfig(api) as RerankConfig | undefined;
                if (!embedCfg) return { content: [{ type: "text", text: "Embedding 未配置。" }] };

                const results = await search({
                    dbPath,
                    tableName: TABLE_NAMES.DOCUMENT,
                    query: params.query,
                    mode: "hybrid",
                    limit: cfg.resultLimit ?? DEFAULT_RESULT_LIMIT,
                    topK: cfg.topK ?? DEFAULT_TOP_K,
                    embedCfg,
                    rerankCfg,
                });

                const formatted = formatMemoryResults(results, LAYER_DESCRIPTIONS[FileLayer.Document]);
                return { content: [{ type: "text", text: formatted || "未找到相关文档。" }] };
            } catch (err) {
                return { content: [{ type: "text", text: `查询文件库失败: ${String(err)}` }] };
            }
        },
    });

    // ═══════════════════════════════════════════════════════════
    // 4. Init — ensure all tables on startup
    // ═══════════════════════════════════════════════════════════

    const dbPath = getLanceDbPath(api);
    if (dbPath) {
        const cfg = getPluginConfig(api);
        const dims = cfg.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS;
        ensureAllTables(dbPath, dims).catch((err) => {
            api.logger?.warn?.(`Failed to initialize LanceDB tables: ${String(err)}`);
        });
    }
}
