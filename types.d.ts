declare module "fs" {
    export function readFileSync(path: string, encoding: string): string;
    export function writeFileSync(path: string, data: string, encoding?: string): void;
    export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
    export function existsSync(path: string): boolean;
    export function readdirSync(path: string, options?: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    export function statSync(path: string): { mtimeMs: number; size: number };
    export function openSync(path: string, flags: string): number;
    export function closeSync(fd: number): void;
    export function watch(
        path: string,
        options: { recursive?: boolean },
        listener: (eventType: string, filename: string | null) => void,
    ): { close(): void };
}

declare module "os" {
    export function tmpdir(): string;
}

declare module "child_process" {
    export interface ChildProcess {
        pid?: number;
        unref(): void;
        on(event: string, listener: (...args: any[]) => void): void;
    }
    export interface SpawnOptions {
        cwd?: string;
        env?: Record<string, string | undefined>;
        stdio?: string | number | Array<string | number | null>;
        detached?: boolean;
        shell?: boolean;
    }
    export function spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
    export function execSync(command: string, options?: { encoding?: string; timeout?: number }): string;
}

declare module "path" {
    export function resolve(...paths: string[]): string;
    export function basename(path: string, ext?: string): string;
    export function extname(path: string): string;
    export function join(...paths: string[]): string;
}

declare var __dirname: string;
declare var process: {
    argv: string[];
    exit(code?: number): never;
    env: Record<string, string | undefined>;
};

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
