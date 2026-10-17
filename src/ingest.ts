import { App, Notice, TFile } from "obsidian";
import type { Graph } from "./neo4j";
import type { Llm } from "./llm";
import type { NoteBoiSettings } from "./settings";

export interface RawChunk {
  heading: string;
  text: string;
}

const MAX_CHUNK = 1200;

/** Splits markdown by heading, then packs paragraphs/bullets up to ~MAX_CHUNK chars. */
export function chunkMarkdown(md: string): RawChunk[] {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    const h = !inFence && /^#{1,6}\s+(.*)$/.exec(line);
    if (h) sections.push({ heading: h[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }

  const chunks: RawChunk[] = [];
  for (const sec of sections) {
    // blocks separated by blank lines; a long list of bullets still splits at the size limit below
    const blocks = sec.lines.join("\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    let cur = "";
    const flush = () => {
      if (cur.trim().length > 20) chunks.push({ heading: sec.heading, text: cur.trim() });
      cur = "";
    };
    for (const block of blocks) {
      for (const piece of splitLong(block)) {
        if (cur && cur.length + piece.length > MAX_CHUNK) flush();
        cur += (cur ? "\n\n" : "") + piece;
      }
    }
    flush();
  }
  return chunks;
}

function splitLong(block: string): string[] {
  if (block.length <= MAX_CHUNK) return [block];
  const out: string[] = [];
  let cur = "";
  for (const line of block.split("\n")) {
    if (cur && cur.length + line.length > MAX_CHUNK) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line.slice(0, MAX_CHUNK * 2);
  }
  if (cur) out.push(cur);
  return out;
}

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export class Indexer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private app: App,
    private graph: Graph,
    private llm: Llm,
    private settings: () => NoteBoiSettings,
  ) { }

  /** Serialises all graph writes so vault events and a full index never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async prepareSchema(): Promise<boolean> {
    const [probe] = await this.llm.embed(["dimension probe"]);
    return this.graph.ensureSchema(this.settings().embedModel, probe.length);
  }

  indexVault(): Promise<void> {
    return this.enqueue(async () => {
      const notice = new Notice("NoteBoi: preparing index…", 0);
      try {
        const rebuilt = await this.prepareSchema();
        const existing = rebuilt ? new Map<string, string>() : await this.graph.indexedHashes();
        const files = this.app.vault.getMarkdownFiles();

        const todo: TFile[] = [];
        const hashes = new Map<string, string>();
        for (const f of files) {
          const hash = hashText(await this.app.vault.cachedRead(f));
          hashes.set(f.path, hash);
          if (existing.get(f.path) !== hash) todo.push(f);
        }

        // drop notes that no longer exist in the vault
        const live = new Set(files.map((f) => f.path));
        for (const path of existing.keys()) if (!live.has(path)) await this.deleteNoteRaw(path);

        let i = 0;
        for (const f of todo) {
          notice.setMessage(`NoteBoi: indexing ${++i}/${todo.length}: ${f.basename}`);
          await this.indexFileRaw(f);
        }
        await this.pruneConcepts();
        notice.hide();
        new Notice(
          `NoteBoi: indexed ${todo.length} note(s)${rebuilt ? " (full rebuild: embedding model changed)" : ""}.`,
        );
      } catch (e) {
        notice.hide();
        new Notice(`NoteBoi: indexing failed: ${(e as Error).message}`, 10000);
        throw e;
      }
    });
  }

  indexFile(file: TFile): Promise<void> {
    return this.enqueue(async () => {
      await this.prepareSchema();
      await this.indexFileRaw(file);
      await this.pruneConcepts();
    });
  }

  deleteNote(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.deleteNoteRaw(path);
      await this.pruneConcepts();
    });
  }

  private async deleteNoteRaw(path: string) {
    await this.graph.run("MATCH (n:Note {path: $path}) OPTIONAL MATCH (n)-[:HAS_CHUNK]->(c) DETACH DELETE c, n", { path });
  }

  private async pruneConcepts() {
    await this.graph.run("MATCH (k:Concept) WHERE NOT (k)<-[:MENTIONS]-() DETACH DELETE k");
  }

  private async indexFileRaw(file: TFile) {
    const content = await this.app.vault.cachedRead(file);
    const chunks = chunkMarkdown(content);
    const path = file.path;

    await this.graph.run("MATCH (n:Note {path: $path})-[:HAS_CHUNK]->(c) DETACH DELETE c", { path });
    // hash is cleared now and only stored once the note is fully indexed, so a failed run is retried next time
    await this.graph.run(
      "MERGE (n:Note {path: $path}) SET n.title = $title, n.mtime = $mtime, n.hash = null",
      { path, title: file.basename, mtime: file.stat.mtime },
    );
    await this.writeLinks(file);
    const markIndexed = () =>
      this.graph.run("MATCH (n:Note {path: $path}) SET n.hash = $hash", { path, hash: hashText(content) });

    if (chunks.length === 0) return void (await markIndexed());

    const embeddings = await this.llm.embed(chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)));
    const { concepts, failed } = await this.extractConcepts(chunks);
    if (failed > 0) {
      new Notice(`NoteBoi: concept extraction failed for ${failed} chunk(s) in ${file.basename}; it will be retried on the next index.`);
    }
    const rows = chunks.map((c, order) => ({
      id: `${path}#${order}`,
      text: c.text,
      heading: c.heading,
      order,
      embedding: embeddings[order],
      concepts: concepts[order],
    }));

    await this.graph.run(
      `MATCH (n:Note {path: $path})
       UNWIND $rows AS row
       CREATE (c:Chunk {id: row.id, text: row.text, heading: row.heading, order: row.order, embedding: row.embedding})
       CREATE (n)-[:HAS_CHUNK]->(c)
       WITH c, row
       UNWIND row.concepts AS name
       MERGE (k:Concept {nameLower: toLower(name)}) ON CREATE SET k.name = name
       MERGE (c)-[:MENTIONS]->(k)`,
      { path, rows },
    );
    await this.graph.run(
      `MATCH (:Note {path: $path})-[:HAS_CHUNK]->(c:Chunk)
       WITH c ORDER BY c.order
       WITH collect(c) AS cs
       UNWIND range(0, size(cs) - 2) AS i
       WITH cs[i] AS a, cs[i + 1] AS b
       MERGE (a)-[:NEXT]->(b)`,
      { path },
    );
    await this.graph.run(
      `MATCH (:Note {path: $path})-[:HAS_CHUNK]->(c:Chunk)-[:MENTIONS]->(a:Concept)
       MATCH (c)-[:MENTIONS]->(b:Concept)
       WHERE elementId(a) < elementId(b)
       MERGE (a)-[:RELATED_TO]-(b)`,
      { path },
    );
    if (failed === 0) await markIndexed();
  }

  private async writeLinks(file: TFile) {
    const cache = this.app.metadataCache;
    const resolved = Object.keys(cache.resolvedLinks[file.path] ?? {}).filter((p) => p.endsWith(".md"));
    await this.graph.run("MATCH (:Note {path: $path})-[r:LINKS_TO]->() DELETE r", { path: file.path });
    if (resolved.length) {
      await this.graph.run(
        `MATCH (n:Note {path: $path})
         UNWIND $targets AS t
         MERGE (m:Note {path: t.path}) ON CREATE SET m.title = t.title
         MERGE (n)-[:LINKS_TO]->(m)`,
        {
          path: file.path,
          targets: resolved.map((p) => ({ path: p, title: p.split("/").pop()!.replace(/\.md$/, "") })),
        },
      );
    }
    const tags = (cache.getFileCache(file)?.tags ?? []).map((t) => t.tag.replace(/^#/, ""));
    await this.graph.run("MATCH (:Note {path: $path})-[r:TAGGED]->() DELETE r", { path: file.path });
    if (tags.length) {
      await this.graph.run(
        `MATCH (n:Note {path: $path})
         UNWIND $tags AS tag
         MERGE (t:Tag {name: tag})
         MERGE (n)-[:TAGGED]->(t)`,
        { path: file.path, tags: [...new Set(tags)] },
      );
    }
  }

  /**
   * Asks the LLM for key concepts, one chunk per call (small local models can't keep several excerpts apart).
   * `failed` counts chunks whose extraction errored or was unparseable after a retry, so the caller can
   * avoid marking the note as fully indexed.
   */
  private async extractConcepts(chunks: RawChunk[]): Promise<{ concepts: string[][]; failed: number }> {
    const concepts: string[][] = chunks.map(() => []);
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        const got = await this.extractOne(chunks[i]);
        if (got === null) failed++;
        else concepts[i] = got;
      }
    };
    await Promise.all(Array.from({ length: CONCEPT_CONCURRENCY }, worker));
    return { concepts, failed };
  }

  private async extractOne(chunk: RawChunk): Promise<string[] | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await this.llm.chat(
          [
            {
              role: "system",
              content:
                'Extract 2-6 key concepts from the note excerpt. Reply ONLY with JSON: {"concepts": ["concept one", "concept two"]}. Each concept is a short lowercase noun phrase (1-3 words).',
            },
            { role: "user", content: chunk.text.slice(0, 1500) },
          ],
          { json: true, maxTokens: 200 },
        );
        const parsed = parseConcepts(reply);
        if (parsed) return parsed;
      } catch (e) {
        console.warn("NoteBoi: concept extraction failed", e);
      }
    }
    return null;
  }
}

const CONCEPT_CONCURRENCY = 3;

/** Returns null if the reply has no usable `concepts` field. Tolerates strings or {concept|name|term} objects. */
export function parseConcepts(reply: string): string[] | null {
  const match = /[{[][\s\S]*[}\]]/.exec(reply);
  if (!match) return null;
  let raw: unknown;
  try {
    const parsed = JSON.parse(match[0]);
    raw = Array.isArray(parsed) ? parsed : parsed?.concepts;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const names = raw.map((x: unknown) => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const v = o.concept ?? o.name ?? o.term ?? o.title;
      return typeof v === "string" ? v : "";
    }
    return "";
  });
  const clean = names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 1 && n.length < 60);
  return [...new Set(clean)].slice(0, 8);
}
