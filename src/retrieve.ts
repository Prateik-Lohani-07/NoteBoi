import type { Graph } from "./neo4j";
import type { Llm } from "./llm";

export interface Passage {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  role: "seed" | "expanded";
  via: string[];
}

export interface VizNode {
  id: string;
  label: string;
  kind: "chunk" | "note" | "concept";
  role: "seed" | "expanded" | "context";
  path?: string;
  heading?: string;
}

export interface VizEdge {
  source: string;
  target: string;
  type: string;
}

export interface Retrieval {
  passages: Passage[];
  nodes: VizNode[];
  edges: VizEdge[];
}

const SEEDS = 5;
const EXPANDED = 4;
const STOP = new Set(["the", "and", "what", "which", "that", "this", "with", "from", "have", "does", "about", "how", "why", "when", "who", "are", "was", "were", "for", "you", "can", "tell", "know"]);

function lucene(question: string): string {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12).join(" OR ");
}

export async function retrieve(graph: Graph, llm: Llm, question: string): Promise<Retrieval> {
  const [vec] = await llm.embed([question]);

  const vecRows = await graph.run(
    `CALL db.index.vector.queryNodes('chunk_embedding', 10, $vec) YIELD node, score
     RETURN node.id AS id, score`,
    { vec },
  );
  const q = lucene(question);
  const ftRows = q
    ? await graph.run(
        `CALL db.index.fulltext.queryNodes('chunk_text', $q) YIELD node, score
         RETURN node.id AS id, score LIMIT 10`,
        { q },
      )
    : [];

  // reciprocal rank fusion of the vector and keyword rankings
  const fused = new Map<string, number>();
  for (const rows of [vecRows, ftRows]) {
    rows.forEach((r, rank) => {
      const id = r.get("id") as string;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank));
    });
  }
  const seedIds = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEDS).map(([id]) => id);
  if (seedIds.length === 0) return { passages: [], nodes: [], edges: [] };

  // graph expansion: chunks sharing concepts with the seeds, ranked by overlap
  const viaConcept = await graph.run(
    `MATCH (c:Chunk) WHERE c.id IN $ids
     MATCH (c)-[:MENTIONS]->(k:Concept)<-[:MENTIONS]-(o:Chunk)
     WHERE NOT o.id IN $ids
     WITH o, collect(DISTINCT k.name) AS via, count(DISTINCT k) AS shared
     ORDER BY shared DESC LIMIT ${EXPANDED}
     RETURN o.id AS id, via`,
    { ids: seedIds },
  );
  const viaMap = new Map<string, string[]>(viaConcept.map((r) => [r.get("id") as string, r.get("via") as string[]]));

  // plus sequential neighbours, for surrounding context
  const neighbours = await graph.run(
    `MATCH (c:Chunk) WHERE c.id IN $ids
     MATCH (c)-[:NEXT]-(o:Chunk) WHERE NOT o.id IN $ids
     RETURN DISTINCT o.id AS id LIMIT 3`,
    { ids: seedIds },
  );
  for (const r of neighbours) if (!viaMap.has(r.get("id") as string)) viaMap.set(r.get("id") as string, []);

  const expandedIds = [...viaMap.keys()];
  const allIds = [...seedIds, ...expandedIds];

  const rows = await graph.run(
    `MATCH (n:Note)-[:HAS_CHUNK]->(c:Chunk) WHERE c.id IN $all
     OPTIONAL MATCH (c)-[:MENTIONS]->(k:Concept)
     RETURN c.id AS id, c.text AS text, c.heading AS heading, n.path AS path, n.title AS title,
            collect(DISTINCT k.name) AS concepts`,
    { all: allIds },
  );
  const byId = new Map(rows.map((r) => [r.get("id") as string, r]));

  const passages: Passage[] = [];
  for (const id of allIds) {
    const r = byId.get(id);
    if (!r) continue;
    passages.push({
      id,
      path: r.get("path"),
      title: r.get("title"),
      heading: r.get("heading") ?? "",
      text: r.get("text"),
      role: seedIds.includes(id) ? "seed" : "expanded",
      via: viaMap.get(id) ?? [],
    });
  }

  // ---- build the visualised subgraph ----
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const noteIds = new Map<string, string>();
  const conceptCount = new Map<string, string[]>();

  for (const p of passages) {
    nodes.push({
      id: p.id,
      label: p.heading || p.title,
      kind: "chunk",
      role: p.role,
      path: p.path,
      heading: p.heading,
    });
    if (!noteIds.has(p.path)) {
      noteIds.set(p.path, `note:${p.path}`);
      nodes.push({ id: `note:${p.path}`, label: p.title, kind: "note", role: "context", path: p.path });
    }
    edges.push({ source: `note:${p.path}`, target: p.id, type: "HAS_CHUNK" });
    for (const k of (byId.get(p.id)!.get("concepts") as string[]) ?? []) {
      conceptCount.set(k, [...(conceptCount.get(k) ?? []), p.id]);
    }
  }
  // only show concepts that connect at least two retrieved chunks: those are what made the graph useful
  for (const [k, chunkIds] of conceptCount) {
    if (chunkIds.length < 2) continue;
    nodes.push({ id: `concept:${k}`, label: k, kind: "concept", role: "context" });
    for (const id of chunkIds) edges.push({ source: id, target: `concept:${k}`, type: "MENTIONS" });
  }

  const next = await graph.run(
    "MATCH (a:Chunk)-[:NEXT]->(b:Chunk) WHERE a.id IN $all AND b.id IN $all RETURN a.id AS a, b.id AS b",
    { all: allIds },
  );
  for (const r of next) edges.push({ source: r.get("a"), target: r.get("b"), type: "NEXT" });

  const links = await graph.run(
    "MATCH (a:Note)-[:LINKS_TO]->(b:Note) WHERE a.path IN $paths AND b.path IN $paths RETURN a.path AS a, b.path AS b",
    { paths: [...noteIds.keys()] },
  );
  for (const r of links) edges.push({ source: `note:${r.get("a")}`, target: `note:${r.get("b")}`, type: "LINKS_TO" });

  return { passages, nodes, edges };
}

export function buildPrompt(question: string, passages: Passage[]) {
  const context = passages
    .map((p, i) => {
      const link = `[[${p.path.replace(/\.md$/, "")}${p.heading ? "#" + p.heading : ""}]]`;
      return `--- Source ${i + 1}: ${link}${p.via.length ? ` (related via: ${p.via.join(", ")})` : ""}\n${p.text}`;
    })
    .join("\n\n");
  return [
    {
      role: "system" as const,
      content:
        "You answer questions using ONLY the user's own notes below. Be concise. Cite each fact with the exact [[wikilink]] given for its source. If the notes don't contain the answer, say so plainly instead of guessing.",
    },
    { role: "user" as const, content: `Notes:\n${context}\n\nQuestion: ${question}` },
  ];
}
