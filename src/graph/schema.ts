const _schemaInitialized = new Set<string>();

export async function ensureGraphSchema(dbPath: string, conn: any): Promise<void> {
    if (_schemaInitialized.has(dbPath)) return;

    // Create Entity node table
    try {
        await conn.query(
            `CREATE NODE TABLE IF NOT EXISTS Entity(
                name STRING,
                entity_type STRING,
                mention_count INT64,
                createdAt STRING,
                PRIMARY KEY(name)
            )`
        );
    } catch (err: any) {
        const msg = String(err);
        if (!msg.includes("already exists") && !msg.includes("already defined")) throw err;
    }

    // Create Relation edge table
    try {
        await conn.query(
            `CREATE REL TABLE IF NOT EXISTS RELATES_TO(
                FROM Entity TO Entity,
                relation STRING,
                weight DOUBLE,
                createdAt STRING
            )`
        );
    } catch (err: any) {
        const msg = String(err);
        if (!msg.includes("already exists") && !msg.includes("already defined")) throw err;
    }

    _schemaInitialized.add(dbPath);
}
