declare module "fs" {
    export function readFileSync(path: string, encoding: string): string;
    export function existsSync(path: string): boolean;
    export function readdirSync(path: string, options?: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    export function statSync(path: string): { mtimeMs: number; size: number };
    export function watch(
        path: string,
        options: { recursive?: boolean },
        listener: (eventType: string, filename: string | null) => void,
    ): { close(): void };
}

declare module "path" {
    export function resolve(...paths: string[]): string;
    export function basename(path: string, ext?: string): string;
    export function extname(path: string): string;
    export function join(...paths: string[]): string;
}

declare module "@lancedb/lancedb" {
    export type LanceDbRow = Record<string, unknown>;

    export type LanceDbIndexConfig = {
        config?: {
            inner?: unknown;
        };
        replace?: boolean;
    };

    export type LanceDbSearchBuilder = {
        limit(limit: number): {
            toArray(): Promise<LanceDbRow[]>;
        };
        select(columns: string[]): LanceDbSearchBuilder;
        where(filter: string): LanceDbSearchBuilder;
    };

    export type LanceDbTable = {
        search(
            query: string | number[] | Float32Array,
            queryType?: string,
            ftsColumns?: string[],
        ): LanceDbSearchBuilder;
        add(data: LanceDbRow[]): Promise<unknown>;
        update(options: { where: string; values: Record<string, unknown> }): Promise<void>;
        delete(filter: string): Promise<void>;
        createIndex(column: string, options?: LanceDbIndexConfig): Promise<void>;
        countRows(): Promise<number>;
    };

    export class Index {
        static fts(): Index;
    }

    export type LanceDbConnection = {
        tableNames(): Promise<string[]>;
        openTable(name: string): Promise<LanceDbTable>;
        createTable(name: string, data: LanceDbRow[]): Promise<LanceDbTable>;
        dropTable(name: string): Promise<void>;
    };

    export function connect(uri: string): Promise<LanceDbConnection>;
}
