import { MemoryLayer, FileLayer, LAYER_DESCRIPTIONS } from "../memory/layers";
import type { ChatMessage } from "./client";

// ─── Layer Selection Prompt ───
// Given user query, LLM decides which memory layers to search.

export function buildLayerSelectionMessages(userQuery: string, context?: string): ChatMessage[] {
    const layerList = [
        ...Object.values(MemoryLayer).map((l) => `- ${l}: ${LAYER_DESCRIPTIONS[l]}`),
        ...Object.values(FileLayer).map((l) => `- ${l}: ${LAYER_DESCRIPTIONS[l]}`),
    ].join("\n");

    const systemPrompt = `你是一个记忆检索路由系统。根据用户的问题，判断应该查询哪些记忆层。

可用的记忆层：
${layerList}

规则：
1. 分析用户问题的意图，选择最相关的记忆层
2. 可以同时选择多个层
3. 除非用户明确提到"日记"、"日记本"，否则不要选择 diary 层
4. 除非用户明确提到"文档"、"文件"、"文件库"，否则不要选择 document 层
5. 如果用户问的是态度/看法/感受相关，选择 attitude 层
6. 如果用户问的是概念/定义/是什么，选择 fact 层
7. 如果用户问的是怎么做/该不该做/最佳实践，选择 knowledge 层
8. 如果用户问的是选择/偏好/用哪个，选择 preference 层
9. 如果难以判断具体类型，同时选择所有四个记忆层（attitude, fact, knowledge, preference）

仅输出 JSON，不要输出其他内容：
{
  "layers": ["layer1", "layer2"],
  "reason": "简短说明选择理由"
}`;

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    if (context) {
        messages.push({ role: "user", content: `上下文信息：${context}` });
    }

    messages.push({ role: "user", content: `用户问题：${userQuery}` });

    return messages;
}

// ─── Memory Extraction Prompt ───
// Extract four types of memories from input text.

export function buildMemoryExtractionMessages(inputText: string): ChatMessage[] {
    const systemPrompt = `你是一个记忆提取系统。从给定的文本中提取以下四类记忆信息：

1. **态度 (attitudes)**: 关于"我"对某事物的态度、看法、情感倾向
   - 格式：{ "subject": "事物", "attitude": "态度描述", "content": "原始相关内容摘要" }

2. **事实 (facts)**: 关于某事物是什么的概念定义
   - 格式：{ "subject": "事物", "definition": "定义/解释", "content": "原始相关内容摘要" }

3. **客观知识 (knowledge)**: 在什么情景下应该怎么做、不能怎么做
   - 格式：{ "scenario": "情景描述", "action": "应该/不应该做什么", "content": "原始相关内容摘要" }

4. **主观选择 (preferences)**: 面对多个选项时的主观倾向
   - 格式：{ "scenario": "选择情景", "options": "可选项描述", "preferred": "倾向选择", "content": "原始相关内容摘要" }

规则：
- 仔细分析文本，提取所有可发现的记忆
- 每条记忆应该是独立的、原子化的
- content 字段是对原始文本中相关部分的简洁摘要
- 如果某一类别没有发现相关信息，返回空数组
- 使用与输入文本相同的语言

仅输出 JSON：
{
  "attitudes": [...],
  "facts": [...],
  "knowledge": [...],
  "preferences": [...]
}`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: inputText },
    ];
}

// ─── Memory Decision Prompt (Mem0-style) ───
// Given new facts + old memory candidates, decide ADD/UPDATE/DELETE/NONE.

export type OldMemoryCandidate = {
    shortId: string;
    content: string;
};

export function buildMemoryDecisionMessages(
    newFacts: string[],
    oldMemories: OldMemoryCandidate[],
): ChatMessage[] {
    const oldMemoryList = oldMemories.length > 0
        ? oldMemories.map((m) => `[${m.shortId}] ${m.content}`).join("\n")
        : "(无现有相关记忆)";

    const newFactsList = newFacts.map((f, i) => `${i + 1}. ${f}`).join("\n");

    const systemPrompt = `你是一个记忆管理系统。根据新提取的事实和现有的旧记忆候选，决定每条记忆应该执行什么操作。

现有旧记忆（方括号中是短ID）：
${oldMemoryList}

新提取的事实：
${newFactsList}

对每条新事实和每条旧记忆，决定执行以下操作之一：

1. **ADD** — 新事实包含旧记忆里没有的新信息，需要新增一条记忆
2. **UPDATE** — 新事实和某条旧记忆表达同一主题，但新事实更完整、更新或更准确。必须指定要更新的旧记忆短ID
3. **DELETE** — 新事实与某条旧记忆明显冲突，旧记忆已过时。必须指定要删除的旧记忆短ID
4. **NONE** — 新事实与旧记忆已等价，或不需要任何变更

规则：
- UPDATE 必须保留同一个旧记忆的短ID
- DELETE 只能删除上面列出的现有旧记忆
- 不能凭空生成不存在的旧记忆ID
- 一条新事实可能同时触发一个 ADD 和一个 DELETE（替换场景）
- 如果旧记忆列表为空，所有事实都应该是 ADD

仅输出 JSON：
{
  "actions": [
    { "event": "ADD", "text": "要新增的记忆文本", "factIndex": 0 },
    { "event": "UPDATE", "oldId": "0", "text": "更新后的记忆文本", "factIndex": 0 },
    { "event": "DELETE", "oldId": "1", "factIndex": 1 },
    { "event": "NONE", "factIndex": 2 }
  ]
}`;

    return [{ role: "system", content: systemPrompt }];
}

// ─── Document Summary Prompt ───

export function buildDocumentSummaryMessages(content: string, title?: string): ChatMessage[] {
    const systemPrompt = `你是一个文档摘要系统。为给定的文档生成一段简洁的摘要（200-500字）。

要求：
- 提取文档的核心内容和关键信息
- 保留重要的概念、结论和关键数据
- 使用与原文相同的语言
- 摘要应该独立可理解

仅输出摘要文本，不要附加其他说明。`;

    const userContent = title ? `标题：${title}\n\n${content}` : content;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
    ];
}

// ─── Context Assembly Prompt ───

export function buildContextAssemblyMessages(
    userQuery: string,
    memoryResults: string,
): ChatMessage[] {
    const systemPrompt = `你是一个记忆上下文组装系统。根据用户的问题和检索到的记忆信息，组装一段简洁、相关的上下文。

规则：
1. 只保留与用户问题直接相关的记忆
2. 去除明显不相关的信息
3. 按重要性和可信度排序
4. 输出格式清晰，便于AI参考
5. 不要回答用户的问题，只整理相关上下文

直接输出整理后的上下文文本。`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: `用户问题：${userQuery}\n\n检索到的记忆：\n${memoryResults}` },
    ];
}
