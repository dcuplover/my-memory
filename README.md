# my-memory — OpenClaw 分层记忆插件

基于 LanceDB 的分层记忆系统，采用 **embedding + BM25 全文检索 + Reranker** 混合检索，通过 Mem0 式"向量召回 + LLM 决策"实现智能记忆增删改查。

---

## 快速开始

### 1. 安装依赖

```bash
cd my-memory
npm install
```

### 2. 配置插件

在 OpenClaw 全局配置文件中添加：

```json
{
  "plugins": {
    "entries": {
      "my-memory": {
        "config": {
          "lanceDbPath": "/path/to/your/lancedb-data",
          "embedBaseUrl": "https://api.openai.com/v1",
          "embedModel": "text-embedding-3-small",
          "embedApiKey": "sk-xxx",
          "llmBaseUrl": "https://api.openai.com/v1",
          "llmModel": "gpt-4o-mini",
          "llmApiKey": "sk-xxx"
        }
      }
    }
  }
}
```

### 3. 启动

插件加载后会自动初始化 6 张 LanceDB 表，无需手动建表。

---

## 配置项说明

### 必填配置

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `lanceDbPath` | string | LanceDB 数据库文件夹路径 |
| `embedBaseUrl` | string | Embedding 服务 URL（OpenAI 兼容） |
| `embedModel` | string | Embedding 模型名称，如 `text-embedding-3-small` |
| `embedApiKey` | string | Embedding 服务 API Key |
| `llmBaseUrl` | string | LLM 服务 URL（OpenAI 兼容） |
| `llmModel` | string | LLM 模型名称，如 `gpt-4o-mini` |
| `llmApiKey` | string | LLM 服务 API Key |

### 可选配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `embedDimensions` | integer | 1536 | Embedding 向量维度 |
| `resultLimit` | integer | 5 | 查询返回结果数 |
| `topK` | integer | 10 | Rerank 前召回候选数量 |
| `ftsColumns` | string[] | — | 自定义全文索引列 |
| `rerankBaseUrl` | string | — | Rerank 服务 URL |
| `rerankModel` | string | — | Rerank 模型名称 |
| `rerankApiKey` | string | — | Rerank 服务 API Key |
| `channelWeightsPath` | string | 插件目录下 `channel_weights.json` | 渠道可信度权重文件路径 |
| `chunkSize` | integer | 512 | 文档切分字符数 |
| `chunkOverlap` | integer | 128 | 文档切分重叠字符数 |

> 配置了 `rerankBaseUrl` + `rerankModel` + `rerankApiKey` 后，混合检索会自动启用 Reranker 重排序。

---

## 记忆分层架构

插件将记忆分为 **记忆层**（4 层）和 **文件层**（2 层），每层对应一张独立的 LanceDB 表：

### 记忆层

| 层级 | 表名 | 用途 | 示例 |
|------|------|------|------|
| **态度层** | `memory_attitude` | 我对某事物的态度/看法 | "我不喜欢 Java 的冗长语法" |
| **事实层** | `memory_fact` | 某事物是什么（概念定义） | "LanceDB 是一个嵌入式向量数据库" |
| **客观知识层** | `memory_knowledge` | 什么情景下该怎么做/不能做 | "使用 Python 时不要用可变对象作默认值" |
| **价值观选择层** | `memory_preference` | 面对多条路径时基于价值观的取舍 | "选择更复杂但稳定的方案，而非简单但临时的快速修复" |

### 文件层

| 层级 | 表名 | 用途 | 处理方式 |
|------|------|------|----------|
| **日记本层** | `file_diary` | 日记全文检索 | 滑动窗口切分 → 每段向量化 → 全文索引 |
| **文件库层** | `file_document` | 文档摘要检索 | LLM 生成摘要 → 摘要向量化 → 保留文件路径 |

---

## 使用方式

### 自动记忆查询（无需操作）

插件通过 `before_prompt_build` 钩子自动工作：

1. 你正常向 AI 提问
2. 插件自动调用 LLM 判断该查询哪些记忆层
3. 对选中的层执行混合检索（向量 + BM25 + 可选 Rerank）
4. 将结果按可信度排序，注入到 AI 上下文中
5. AI 参考记忆内容回答你的问题

**文件层特殊处理**：除非你明确提到"日记"或"文档"，否则只会提示"存在 N 条相关记录"，不会自动展开全部内容。

---

### 斜杠命令

| 命令 | 说明 | 用法 |
|------|------|------|
| `/add_memory` | 从文本中提取四层记忆 | `/add_memory 这段文字的内容...` |
| `/add_diary` | 添加日记（支持文件路径或直接文本） | `/add_diary /path/to/diary.md` 或 `/add_diary 今天做了...` |
| `/add_document` | 添加文档到文件库 | `/add_document 文档正文内容...` |
| `/query_diary` | 直接查询日记本 | `/query_diary 上次实验的结果` |
| `/query_document` | 直接查询文件库 | `/query_document LanceDB 使用方法` |
| `/extract_diary_memory` | 从日记中提取四层记忆 | `/extract_diary_memory 2024-01-15` |
| `/extract_document_memory` | 从文档中提取四层记忆 | `/extract_document_memory 文档内容...` |
| `/list_memory` | 查看已存储的记忆列表 | `/list_memory` 或 `/list_memory attitude` 或 `/list_memory fact 关键词` |

---

### AI 工具

以下工具注册后 AI 可自动判断调用时机：

| 工具名 | 触发场景 |
|--------|----------|
| `add_memory` | 当你说"记住这个"、"保存这条信息" |
| `add_diary` | 当你说"把这个存为日记"、"导入这篇日记" |
| `add_document` | 当你说"索引这个文档" |
| `query_diary` | 当你说"搜索我的日记" |
| `query_document` | 当你说"查找文档" |
| `extract_diary_memory` | 当你说"从日记里提取记忆"、"整理日记中的知识" |
| `extract_document_memory` | 当你说"从这篇文档提取记忆"、"整理文档中的知识" |
| `list_memory` | 当你说"查看我的记忆"、"列出态度层记忆"、"搜索记忆 XXX" |

---

## 记忆添加流程

当通过 `/add_memory` 或 `add_memory` 工具添加记忆时，插件执行以下流程：

```
输入文本
  ↓
LLM 提取四类记忆（态度/事实/知识/偏好）
  ↓
对每条提取结果生成 embedding
  ↓
在对应层向量召回 top-5 旧记忆候选
  ↓
短 ID 映射（防止 LLM 幻觉）
  ↓
LLM 决策：ADD / UPDATE / DELETE / NONE
  ↓
映射回真实 ID，执行 CRUD 操作
  ↓
返回操作摘要（新增 N / 更新 M / 删除 K）
```

这个流程参考了 Mem0 的两阶段记忆决策机制，能自动处理记忆的去重、更新和冲突删除。

---

## 检索模式

插件支持三种检索模式，默认使用混合模式：

| 模式 | 说明 |
|------|------|
| **hybrid**（默认） | 同时执行向量检索和 BM25 全文检索，归一化分数后加权融合，可选 Reranker 重排 |
| **vector** | 纯向量语义检索 |
| **keyword** | 纯 BM25 关键词检索 |

---

## 可信度机制

每条记忆都带有可信度分值（0-1），由添加时的**渠道**决定。

默认渠道权重（`channel_weights.json`）：

```json
{
  "daily_chat": 0.6,
  "document": 0.8,
  "diary": 0.7,
  "verified": 1.0,
  "user_input": 0.9
}
```

- 查询结果按可信度从高到低排序
- 你可以修改 `channel_weights.json` 自定义渠道和权重
- 添加记忆时可指定渠道，如 `/add_memory` 默认使用 `user_input`

---

## 目录结构

```
my-memory/
├── index.ts                  # 插件入口（注册钩子/命令/工具）
├── openclaw.plugin.json      # 插件清单 + 配置 Schema
├── package.json              # 依赖声明
├── types.d.ts                # LanceDB 类型声明
├── channel_weights.json      # 渠道可信度权重
└── src/
    ├── config.ts             # 配置读取、常量
    ├── formatter.ts          # 结果格式化
    ├── db/
    │   ├── connection.ts     # LanceDB 连接（单例）
    │   ├── crud.ts           # 增删改查
    │   └── schema.ts         # 6 张表定义 + 建表/索引
    ├── document/
    │   ├── chunker.ts        # 滑动窗口切分
    │   ├── diary.ts          # 日记本处理
    │   └── file.ts           # 文件库处理
    ├── embedding/
    │   └── index.ts          # Embedding API 调用
    ├── llm/
    │   ├── client.ts         # LLM API 客户端
    │   ├── decision.ts       # 记忆变更决策（两阶段）
    │   └── prompts.ts        # Prompt 模板
    ├── memory/
    │   ├── add.ts            # 记忆添加主逻辑
    │   ├── extract.ts        # 四层记忆提取
    │   ├── layers.ts         # 层级枚举
    │   └── query.ts          # 记忆查询主逻辑
    └── search/
        ├── hybrid.ts         # 混合检索
        ├── keyword.ts        # BM25 关键词检索
        ├── reranker.ts       # Rerank API
        └── vector.ts         # 向量检索
```
