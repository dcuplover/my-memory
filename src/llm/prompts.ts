import { MemoryLayer, FileLayer, LAYER_DESCRIPTIONS } from "../memory/layers";
import { MAX_CLASSIFICATION_STATEMENTS, MAX_DECISION_OLD_MEMORIES } from "../config";
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
8. 如果用户问的涉及取舍/权衡/价值观倾向/优先级选择，选择 preference 层
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

// ─── Step 1: Distillation Prompt ───
// Distill raw text into atomic, valuable statements.

export function buildDistillationMessages(inputText: string): ChatMessage[] {
    const systemPrompt = `你是一个信息蒸馏系统。从原始文本中提炼出有价值的原子化陈述。

规则：
- 去掉纯行为流水账（"然后我点击了…""接着他说了…"）
- 合并重复表达（同一个意思说了多次的只保留一条）
- 将长句拆分成独立的、简洁的单一含义陈述
- 保留原意，不添加推测
- 丢弃临时性的对话建议（如"建议换用 X 模型""建议再试一次"）
- 丢弃针对特定一次性事件的操作指引（如"将配置改为 DeepSeek"）
- 没有信息价值的内容直接丢弃

输出 JSON 数组，每个元素是一条蒸馏后的陈述字符串：
["陈述1", "陈述2", ...]
如果没有任何有价值的内容，返回空数组 []。使用与输入文本相同的语言。`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: inputText },
    ];
}

// ─── Step 2: Classification Prompt ───
// Classify distilled statements into four memory layers.

export function buildClassificationMessages(statements: string[]): ChatMessage[] {
    const capped = statements.slice(0, MAX_CLASSIFICATION_STATEMENTS);
    const statementsText = capped.map((s, i) => `${i + 1}. ${s}`).join("\n");

    const systemPrompt = `你是一个记忆分类系统。将以下陈述归入四类：

1. **态度 (attitudes)**: "我"对某事物带有明确情感色彩的评价或倾向。必须包含喜欢/讨厌/欣赏/反感/认可/质疑等情感极性，纯粹的事实陈述、技术判断不算态度。
   - ✅ "我觉得 LanceDB 的 API 设计很反直觉" — 有情感评价
   - ✅ "我很喜欢 TypeScript 的类型系统" — 有情感倾向
   - ❌ "JSON 标准不允许 trailing comma" — 事实，不是态度
   - ❌ "发现 CLI 超时是因为递归回复" — 技术分析，不是态度
   - 格式：{ "subject": "事物", "attitude": "带情感色彩的评价", "content": "原始陈述" }

2. **事实 (facts)**: 关于某事物客观上"是什么"的信息。包括定义、状态、属性、因果关系、技术发现等。
   - 格式：{ "subject": "事物", "definition": "定义/解释/发现", "content": "原始陈述" }

3. **客观知识 (knowledge)**: 从经验中抽象出的、稳定可复用的规则或规律。知识必须同时满足：
   - **抽象性**：从具体事件中总结出通用规律，不依赖特定上下文
   - **稳定性**：不会因事件变化而失效（排除临时建议、一次性操作指引）
   - **可复用性**：下次遇到相似问题时可直接作为参考
   - ✅ "Python 中不要用可变对象作函数默认值" — 通用规律，稳定可复用
   - ✅ "HTTP 500 错误可能是临时性的，重试通常有效" — 抽象规律
   - ✅ "心跳消息也会触发 before_prompt_build hook，需要按 trigger 字段过滤" — 可复用的技术知识
   - ❌ "建议换用 Qwen2.5-72B 模型" — 临时建议，绑定特定事件
   - ❌ "将配置中的 llmModel 改为 DeepSeek" — 一次性操作指引
   - ❌ "建议直接再试一次" — 太笼统，不构成可复用知识
   - ❌ "询问是否需要帮助修改配置" — 对话动作，不是知识
   - 格式：{ "scenario": "通用情景描述（不含特定模型名/服务名等一次性细节）", "action": "应该/不应该做什么", "content": "原始陈述" }

4. **价值观选择 (preferences)**: 面对多条路径/方案时，基于价值观的决策倾向。体现在取舍和权衡中。
   - 格式：{ "scenario": "决策情景", "options": "可选路径/方案", "preferred": "倾向选择及其价值观依据", "content": "原始陈述" }

分类原则：
- 态度必须有情感极性，去掉情感词后变成事实陈述的 → 归为事实
- 不确定时，优先归为事实或知识
- 无法归入任何类别的陈述，直接丢弃

仅输出 JSON：
{
  "attitudes": [...],
  "facts": [...],
  "knowledge": [...],
  "preferences": [...]
}
如果某一类别没有相关内容，返回空数组。使用与输入陈述相同的语言。`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: statementsText },
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
    const cappedOld = oldMemories.slice(0, MAX_DECISION_OLD_MEMORIES);
    const oldMemoryList = cappedOld.length > 0
        ? cappedOld.map((m) => `[${m.shortId}] ${m.content}`).join("\n")
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

// ─── Triple Extraction Prompt ───

export function buildTripleExtractionMessages(statements: string[]): ChatMessage[] {
    const itemText = statements.map((item, i) => `${i + 1}. ${item}`).join("\n");

    const systemPrompt = `你是一个知识图谱抽取系统。从蒸馏后的原子化陈述中提取实体关系三元组。

## 实体要求

实体必须属于以下类型之一（entity_type 字段必填）：
- Person — 人名
- Software — 软件、库、框架、工具、产品
- Parameter — 配置参数、环境变量、API 参数
- Platform — 平台、操作系统、运行环境
- Concept — 技术概念、设计模式、方法论
- Organization — 公司、团队、社区
- Format — 文件格式、协议、标准
- Language — 编程语言、自然语言
- Error — 已命名的错误类型或异常类（如 OOM、SegmentFault）
- Other — 确实不属于以上类型的具名实体

### 实体反例（以下不是实体，不要提取）：
- ❌ 错误信息原文："mmap for size 8796093022208 failed" — 这是日志文本，不是实体
- ❌ 带数值的陈述句："maxDBSize 参数默认值为 8TB" — 这是一条事实，需拆为实体 maxDBSize 和关系
- ❌ 动作描述："设置环境变量"、"重启服务" — 动作不是实体
- ❌ 过于笼统的词："问题"、"方案"、"配置"、"错误" — 太模糊，缺乏具体指向

### 实体规范化：
- 同义实体统一命名（如 "Python" 和 "python" → "Python"；"LanceDB" 和 "lancedb" → "LanceDB"）
- 保留实体的通用名称，不带版本号（除非版本是核心区分信息）
- 如果涉及"我"的态度或偏好，使用"用户"作为主体

## 关系要求

关系谓词使用英文小写 snake_case。优先使用以下高价值关系类型：

**分类关系**: is_a, part_of, instance_of
**因果/依赖**: causes, requires, depends_on, triggers
**解决方案**: solved_by, mitigated_by, configured_with, workaround_for
**用途/适用**: used_for, applies_to, supports, compatible_with
**替代/对比**: alternative_to, replaced_by, compared_with
**属性/配置**: has_default, has_parameter, has_property
**态度/偏好**: prefers, dislikes, recommends

避免生成无信息量的关系（如 related_to），尽量使用上述具体类型。

## Few-shot 示例

### 输入陈述：
1. LanceDB 使用 mmap 机制管理磁盘上的向量数据
2. 当 LanceDB 数据库文件过大时，mmap 会因地址空间不足导致 OOM 崩溃
3. 在 32 位系统上 mmap 的地址空间上限约为 2-3GB
4. 可以通过设置 maxDBSize 参数限制 mmap 映射范围来规避 OOM

### 期望输出：
{
  "triples": [
    { "subject": "LanceDB", "subject_type": "Software", "predicate": "uses", "object": "mmap", "object_type": "Concept" },
    { "subject": "mmap", "subject_type": "Concept", "predicate": "causes", "object": "OOM", "object_type": "Error" },
    { "subject": "OOM", "subject_type": "Error", "predicate": "solved_by", "object": "maxDBSize", "object_type": "Parameter" },
    { "subject": "maxDBSize", "subject_type": "Parameter", "predicate": "configured_with", "object": "LanceDB", "object_type": "Software" },
    { "subject": "mmap", "subject_type": "Concept", "predicate": "has_property", "object": "地址空间上限", "object_type": "Concept" }
  ]
}

### 输入陈述：
1. 用户觉得 TypeScript 的类型系统比 JavaScript 更可靠
2. Zod 是一个 TypeScript 优先的 schema 验证库
3. 在需要运行时类型校验的场景中，Zod 优于手动 if-else 校验

### 期望输出：
{
  "triples": [
    { "subject": "用户", "subject_type": "Person", "predicate": "prefers", "object": "TypeScript", "object_type": "Language" },
    { "subject": "Zod", "subject_type": "Software", "predicate": "is_a", "object": "schema 验证库", "object_type": "Concept" },
    { "subject": "Zod", "subject_type": "Software", "predicate": "applies_to", "object": "运行时类型校验", "object_type": "Concept" },
    { "subject": "Zod", "subject_type": "Software", "predicate": "alternative_to", "object": "手动 if-else 校验", "object_type": "Concept" }
  ]
}

## 输出格式

每条陈述可提取 0~3 个三元组。仅输出 JSON：
{
  "triples": [
    { "subject": "实体A", "subject_type": "类型", "predicate": "关系", "object": "实体B", "object_type": "类型" }
  ]
}
如果无法提取有意义的三元组，返回 { "triples": [] }。`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: itemText },
    ];
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

// ─── Deep Article Summary Prompts ───

type PartInfo = {
    partIndex: number;
    totalParts: number;
};

/**
 * 构建深度总结 prompt。
 * 与 buildDocumentSummaryMessages 不同，这里要求保留所有核心信息，不丢失关键细节。
 */
export function buildDeepSummaryMessages(
    content: string,
    title?: string,
    partInfo?: PartInfo,
): ChatMessage[] {
    const partHint = partInfo
        ? `\n\n注意：这是一篇长文的第 ${partInfo.partIndex}/${partInfo.totalParts} 部分。请提取本段中所有核心要点，后续会将各段合并为完整总结。`
        : "";

    const systemPrompt = `你是一个专业的文章深度总结系统。你的任务是对文章进行全面、准确的总结，确保不丢失任何核心信息。

总结要求：
1. **保留关键数据和数字**：统计数据、百分比、指标、性能数字等不可省略
2. **保留核心论点和结论**：作者的主要观点、论证逻辑、最终结论必须完整呈现
3. **保留因果关系**：问题→原因→解决方案的链条必须清晰
4. **保留专有名词和技术概念**：首次出现时附带简要解释
5. **保留实践建议和最佳实践**：可操作的具体建议不可丢弃
6. **保留对比和权衡**：方案对比、优缺点分析等决策信息完整保留

输出格式（Markdown）：
- 使用层级标题组织内容（## 主题 / ### 子主题）
- 核心观点用要点列表
- 重要数据/代码片段保留原文
- 使用与原文相同的语言${partHint}

直接输出总结文本，不要附加额外说明。`;

    const userContent = title ? `标题：${title}\n\n${content}` : content;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
    ];
}

/**
 * 构建合并总结 prompt（Map-Reduce 的 Reduce 阶段）。
 * 将多段分段总结合并为一份完整的深度总结。
 */
export function buildMergeSummaryMessages(
    chunkSummaries: string[],
    title?: string,
): ChatMessage[] {
    const systemPrompt = `你是一个文章总结合并系统。你将收到一篇长文各段的独立总结，请将它们合并为一份完整、连贯、不重复的深度总结。

合并要求：
1. **去重**：不同段落可能重复提及的信息只保留一次
2. **保持完整**：每段总结中的唯一信息都必须保留，不可因合并而丢失
3. **逻辑连贯**：按文章逻辑重新组织结构，而非简单拼接
4. **保留所有关键细节**：数据、结论、因果关系、技术概念、实践建议全部保留

输出格式（Markdown）：
- 使用层级标题组织（## / ###）
- 核心观点用要点列表
- 保留重要数据和代码片段
- 使用与原文相同的语言

直接输出合并后的完整总结，不要附加额外说明。`;

    const titleHint = title ? `文章标题：${title}\n\n` : "";
    const summaryParts = chunkSummaries
        .map((s, i) => `--- 第 ${i + 1} 段总结 ---\n${s}`)
        .join("\n\n");

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${titleHint}以下是各段的独立总结，请合并为一份完整总结：\n\n${summaryParts}` },
    ];
}
