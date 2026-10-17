import neo4j, { Driver, Record as Neo4jRecord } from "neo4j-driver";
import type { NoteBoiSettings } from "./settings";

const OUR_LABELS = ["Note", "Chunk", "Concept", "Tag", "Meta"];

/** Wraps the Bolt driver and owns the schema. */
export class Graph {
  private driver: Driver | null = null;
  private key = "";

  constructor(private s: () => NoteBoiSettings) {}

  private getDriver(): Driver {
    const { neo4jUri, neo4jUser, neo4jPassword } = this.s();
    const key = `${neo4jUri}|${neo4jUser}|${neo4jPassword}`;
    if (!this.driver || key !== this.key) {
      void this.driver?.close();
      this.driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
      this.key = key;
    }
    return this.driver;
  }

  async verify(): Promise<void> {
    await this.getDriver().verifyConnectivity();
  }

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
    const database = this.s().neo4jDatabase || undefined;
    const session = this.getDriver().session({ database });
    try {
      return (await session.run(cypher, params)).records;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = null;
  }

  /**
   * Creates constraints and indexes. Returns true if the embedding model/dimension
   * changed since the last index, in which case our data was wiped and a full re-index is needed.
   */
  async ensureSchema(embedModel: string, dim: number): Promise<boolean> {
    if (!Number.isInteger(dim) || dim < 1) throw new Error(`Bad embedding dimension: ${dim}`);

    await this.run("CREATE CONSTRAINT note_path IF NOT EXISTS FOR (n:Note) REQUIRE n.path IS UNIQUE");
    await this.run("CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE");
    await this.run("CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (k:Concept) REQUIRE k.nameLower IS UNIQUE");
    await this.run("CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE");
    await this.run("CREATE FULLTEXT INDEX chunk_text IF NOT EXISTS FOR (c:Chunk) ON EACH [c.text]");

    const meta = await this.run("MATCH (m:Meta {id: 'index'}) RETURN m.embedModel AS model, m.dim AS dim");
    const prevModel = meta[0]?.get("model");
    const prevDim = meta[0]?.get("dim");
    const changed = meta.length > 0 && (prevModel !== embedModel || Number(prevDim) !== dim);

    if (changed) {
      await this.run("DROP INDEX chunk_embedding IF EXISTS");
      await this.wipe();
    }

    // dim is validated as an integer above; index options cannot be parameterised
    await this.run(
      `CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS FOR (c:Chunk) ON (c.embedding)
       OPTIONS {indexConfig: {\`vector.dimensions\`: ${dim}, \`vector.similarity_function\`: 'cosine'}}`,
    );
    await this.run("MERGE (m:Meta {id: 'index'}) SET m.embedModel = $embedModel, m.dim = $dim", {
      embedModel,
      dim: neo4j.int(dim),
    });
    return changed;
  }

  /** Deletes only the nodes this plugin created, never the rest of the user's database. */
  async wipe(): Promise<void> {
    for (const label of OUR_LABELS.filter((l) => l !== "Meta")) {
      for (;;) {
        const r = await this.run(`MATCH (n:${label}) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS c`);
        if (Number(r[0].get("c")) === 0) break;
      }
    }
  }

  async indexedHashes(): Promise<Map<string, string>> {
    const rows = await this.run("MATCH (n:Note) WHERE n.hash IS NOT NULL RETURN n.path AS path, n.hash AS hash");
    return new Map(rows.map((r) => [r.get("path") as string, r.get("hash") as string]));
  }
}
