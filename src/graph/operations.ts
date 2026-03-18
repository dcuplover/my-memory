import { getGraphConnection } from "./connection";
import { ensureGraphSchema } from "./schema";

export type Triple = {
    subject: string;
    subject_type?: string;
    predicate: string;
    object: string;
    object_type?: string;
};

export type GraphExpansion = {
    expandedEntities: string[];
    paths: { from: string; relation: string; to: string }[];
};

function normalizeEntityName(name: string): string {
    return name.trim().toLowerCase();
}

function escapeCypher(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Upsert an entity node. If exists via MERGE, increment mention_count.
 */
async function upsertEntity(
    conn: any,
    name: string,
    entityType: string = "",
): Promise<void> {
    const normalized = normalizeEntityName(name);
    if (!normalized) return;
    const now = new Date().toISOString();

    try {
        await conn.query(
            `MERGE (e:Entity {name: '${escapeCypher(normalized)}'})
             ON CREATE SET e.entity_type = '${escapeCypher(entityType)}', e.mention_count = 1, e.createdAt = '${escapeCypher(now)}'
             ON MATCH SET e.mention_count = e.mention_count + 1`
        );
    } catch {
        // Fallback: try CREATE, ignore if exists
        try {
            await conn.query(
                `CREATE (e:Entity {name: '${escapeCypher(normalized)}', entity_type: '${escapeCypher(entityType)}', mention_count: 1, createdAt: '${escapeCypher(now)}'})`
            );
        } catch {
            // Entity already exists, fine
        }
    }
}

/**
 * Add a relation between two entities.
 */
async function addSingleRelation(conn: any, triple: Triple): Promise<void> {
    const subj = normalizeEntityName(triple.subject);
    const obj = normalizeEntityName(triple.object);
    if (!subj || !obj || subj === obj) return;

    const now = new Date().toISOString();
    const rel = triple.predicate.trim();
    if (!rel) return;

    // Ensure both entities exist
    await upsertEntity(conn, subj, triple.subject_type ?? "");
    await upsertEntity(conn, obj, triple.object_type ?? "");

    // Check if same relation already exists
    try {
        const existing = await conn.query(
            `MATCH (a:Entity {name: '${escapeCypher(subj)}'})-[r:RELATES_TO]->(b:Entity {name: '${escapeCypher(obj)}'})
             WHERE r.relation = '${escapeCypher(rel)}'
             RETURN r.relation LIMIT 1`
        );
        const rows = await existing.getAll();
        if (rows.length > 0) return; // already exists
    } catch {
        // Table might be empty, continue to create
    }

    await conn.query(
        `MATCH (a:Entity {name: '${escapeCypher(subj)}'}), (b:Entity {name: '${escapeCypher(obj)}'})
         CREATE (a)-[:RELATES_TO {relation: '${escapeCypher(rel)}', weight: 1.0, createdAt: '${escapeCypher(now)}'}]->(b)`
    );
}

/**
 * Store multiple triples in the graph.
 */
export async function storeTriples(dbPath: string, triples: Triple[]): Promise<number> {
    await ensureGraphSchema(dbPath);
    const conn = await getGraphConnection(dbPath);
    let stored = 0;
    for (const triple of triples) {
        try {
            await addSingleRelation(conn, triple);
            stored++;
        } catch (err) {
            console.warn(`[图谱] 存储三元组失败: ${triple.subject} → ${triple.predicate} → ${triple.object}: ${err}`);
        }
    }
    return stored;
}

/**
 * Find entity names that appear as substrings in the given text.
 */
export async function findEntitiesInText(dbPath: string, text: string): Promise<string[]> {
    await ensureGraphSchema(dbPath);
    const conn = await getGraphConnection(dbPath);

    try {
        const result = await conn.query("MATCH (e:Entity) RETURN e.name AS name");
        const rows = await result.getAll();
        const normalizedText = text.toLowerCase();

        return rows
            .map((r: any) => String(r.name ?? ""))
            .filter((name: string) => name.length >= 2 && normalizedText.includes(name));
    } catch {
        return [];
    }
}

/**
 * Expand entities by 1-2 hops in the graph.
 * Returns new entity names and the relationship paths.
 */
export async function expandEntities(
    dbPath: string,
    entityNames: string[],
    maxHops: number = 2,
): Promise<GraphExpansion> {
    await ensureGraphSchema(dbPath);
    const conn = await getGraphConnection(dbPath);

    const normalizedNames = entityNames.map(normalizeEntityName).filter(Boolean);
    if (normalizedNames.length === 0) return { expandedEntities: [], paths: [] };

    const paths: GraphExpansion["paths"] = [];
    const knownSet = new Set(normalizedNames);
    const firstHopNew: string[] = [];

    // Hop 1
    try {
        const nameList = normalizedNames.map(n => `'${escapeCypher(n)}'`).join(",");
        const result = await conn.query(
            `MATCH (a:Entity)-[r:RELATES_TO]-(b:Entity)
             WHERE a.name IN [${nameList}]
             RETURN a.name AS from_name, r.relation AS relation, b.name AS to_name`
        );
        const rows = await result.getAll();

        for (const row of rows) {
            const fromName = String(row.from_name ?? "");
            const relation = String(row.relation ?? "");
            const toName = String(row.to_name ?? "");

            if (toName && !knownSet.has(toName)) {
                knownSet.add(toName);
                firstHopNew.push(toName);
                paths.push({ from: fromName, relation, to: toName });
            }
        }
    } catch {
        // Graph might be empty
    }

    // Hop 2
    if (maxHops >= 2 && firstHopNew.length > 0 && firstHopNew.length <= 20) {
        try {
            const nameList = firstHopNew.map(n => `'${escapeCypher(n)}'`).join(",");
            const result = await conn.query(
                `MATCH (a:Entity)-[r:RELATES_TO]-(b:Entity)
                 WHERE a.name IN [${nameList}]
                 RETURN a.name AS from_name, r.relation AS relation, b.name AS to_name`
            );
            const rows = await result.getAll();

            for (const row of rows) {
                const fromName = String(row.from_name ?? "");
                const relation = String(row.relation ?? "");
                const toName = String(row.to_name ?? "");

                if (toName && !knownSet.has(toName)) {
                    knownSet.add(toName);
                    paths.push({ from: fromName, relation, to: toName });
                }
            }
        } catch {
            // Ignore hop-2 failures
        }
    }

    const expandedEntities = [...knownSet]
        .filter(e => !normalizedNames.includes(e))
        .slice(0, 10);

    return { expandedEntities, paths };
}

/**
 * Get graph statistics.
 */
export async function getGraphStats(dbPath: string): Promise<{ entities: number; relations: number }> {
    await ensureGraphSchema(dbPath);
    const conn = await getGraphConnection(dbPath);

    try {
        const entityResult = await conn.query("MATCH (e:Entity) RETURN count(e) AS cnt");
        const entityRows = await entityResult.getAll();
        const entities = Number(entityRows[0]?.cnt ?? 0);

        const relResult = await conn.query("MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS cnt");
        const relRows = await relResult.getAll();
        const relations = Number(relRows[0]?.cnt ?? 0);

        return { entities, relations };
    } catch {
        return { entities: 0, relations: 0 };
    }
}
