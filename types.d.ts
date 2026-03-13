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
