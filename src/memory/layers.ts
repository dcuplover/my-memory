import { MemoryLayer, FileLayer, MEMORY_LAYER_TABLE_MAP, FILE_LAYER_TABLE_MAP, type TableName } from "../config";

export { MemoryLayer, FileLayer };

export const ALL_MEMORY_LAYERS = Object.values(MemoryLayer);
export const ALL_FILE_LAYERS = Object.values(FileLayer);

export function getTableForMemoryLayer(layer: MemoryLayer): TableName {
    return MEMORY_LAYER_TABLE_MAP[layer];
}

export function getTableForFileLayer(layer: FileLayer): TableName {
    return FILE_LAYER_TABLE_MAP[layer];
}

export function parseMemoryLayers(layers: string[]): MemoryLayer[] {
    return layers
        .map((l) => l.toLowerCase().trim())
        .filter((l): l is MemoryLayer => ALL_MEMORY_LAYERS.includes(l as MemoryLayer));
}

export function parseFileLayers(layers: string[]): FileLayer[] {
    return layers
        .map((l) => l.toLowerCase().trim())
        .filter((l): l is FileLayer => ALL_FILE_LAYERS.includes(l as FileLayer));
}

export const LAYER_DESCRIPTIONS: Record<MemoryLayer | FileLayer, string> = {
    [MemoryLayer.Attitude]: "态度层 — 我对某事物的态度、看法、情感倾向",
    [MemoryLayer.Fact]: "事实层 — 某事物是什么，概念定义",
    [MemoryLayer.Knowledge]: "客观知识层 — 什么情景下要怎么做、不能怎么做",
    [MemoryLayer.Preference]: "主观选择层 — 多选项中我主观倾向选哪一项",
    [FileLayer.Diary]: "日记本层 — 日记全文检索",
    [FileLayer.Document]: "文件库层 — 文档摘要检索",
};
