/**
 * 图谱实体停用词表。
 * 这些词过于宽泛，不适合作为图谱节点参与查询扩展或入库。
 * 查询时：findEntitiesInText / expandEntities 会跳过这些实体。
 * 入库时：extractAndStoreTriples 会过滤包含这些实体的三元组。
 */

const STOPWORD_LIST: string[] = [
    // 过于笼统的中文词
    "数据", "新数据", "旧数据", "问题", "方案", "配置", "错误", "结果",
    "信息", "内容", "文件", "系统", "功能", "模块", "服务", "接口",
    "参数", "变量", "对象", "类型", "状态", "操作", "处理", "方法",
    "代码", "项目", "任务", "流程", "逻辑", "规则", "策略", "模式",
    "工具", "资源", "环境", "设置", "选项", "属性", "字段", "记录",
    "列表", "集合", "元素", "节点", "连接", "请求", "响应", "消息",
    "事件", "回调", "输入", "输出", "格式", "版本", "更新", "修改",
    "用户", "客户端", "服务端", "前端", "后端",

    // 过于笼统的英文词
    "data", "new data", "old data", "problem", "solution", "config",
    "configuration", "error", "result", "info", "information", "content",
    "file", "system", "function", "module", "service", "interface",
    "parameter", "variable", "object", "type", "state", "status",
    "operation", "process", "method", "code", "project", "task",
    "flow", "logic", "rule", "strategy", "pattern", "tool",
    "resource", "environment", "setting", "option", "property", "field",
    "record", "list", "collection", "element", "node", "connection",
    "request", "response", "message", "event", "callback",
    "input", "output", "format", "version", "update", "change",
    "user", "client", "server", "frontend", "backend",

    // 行为/动作描述（不是实体）
    "设置环境变量", "重启服务", "用完即关模式", "短连接模式", "分批处理策略",

    // 现象/状态描述（不是实体）
    "连接超时", "锁冲突", "地址空间不足",
];

const STOPWORD_SET = new Set(STOPWORD_LIST.map(w => w.toLowerCase()));

/**
 * 判断一个实体名是否是停用词。
 */
export function isStopword(entity: string): boolean {
    return STOPWORD_SET.has(entity.trim().toLowerCase());
}

/** 允许的 entity_type 白名单 */
const ALLOWED_ENTITY_TYPES = new Set([
    "person", "software", "parameter", "platform", "concept",
    "organization", "format", "language", "error", "other",
]);

/**
 * 判断一个实体是否通过入库校验。
 * 返回 true 表示实体合法，可以入库。
 */
export function isValidEntity(name: string, entityType?: string): boolean {
    const normalized = name.trim().toLowerCase();

    // 长度过短（单字）
    if (normalized.length < 2) return false;

    // 命中停用词
    if (STOPWORD_SET.has(normalized)) return false;

    // entity_type 不在允许列表内（如果提供了的话）
    if (entityType && !ALLOWED_ENTITY_TYPES.has(entityType.trim().toLowerCase())) return false;

    return true;
}
