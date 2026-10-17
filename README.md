# Graph Recall

Ask your Obsidian vault questions and see *why* an answer was found.

You write notes whenever you learn something, then forget them. Graph Recall indexes your vault into a
[Neo4j](https://neo4j.com) graph, answers questions from your own notes with citations, and draws the
subgraph it used, so you can see which notes matched directly and which were reached by following the graph.

> Desktop only (Obsidian on Windows, macOS or Linux). Mobile is not supported because the plugin talks to Neo4j over Bolt/TCP.

## How it works

**Indexing.** Each note is split by heading into chunks. Each chunk is embedded, and an LLM extracts the key concepts it mentions.

```
(Note)-[:HAS_CHUNK]->(Chunk)-[:NEXT]->(Chunk)
(Chunk)-[:MENTIONS]->(Concept)-[:RELATED_TO]-(Concept)
(Note)-[:LINKS_TO]->(Note)        from [[wikilinks]]
(Note)-[:TAGGED]->(Tag)
```

**Answering.**
1. Vector search (native Neo4j vector index) and keyword search (fulltext index) each rank chunks.
2. The two rankings are fused with Reciprocal Rank Fusion to pick the **seed** chunks.
3. A Cypher traversal follows `(Chunk)-[:MENTIONS]->(Concept)<-[:MENTIONS]-(Chunk)` to pull in related chunks that
   share no words with the question, plus neighbouring chunks for context.
4. The model answers using only those passages and cites them as `[[Note#Heading]]`.
5. The retrieved subgraph is drawn under the answer.

| Colour | Meaning |
|---|---|
| Blue circle | chunk found by search |
| Amber circle | chunk added by graph traversal |
| Green diamond | concept shared by two or more retrieved chunks |
| Grey box | note |

Click a node to open the note at that heading.

## Requirements

- Obsidian 1.5+ (desktop)
- Neo4j 5.x. The included `docker-compose.yml` starts one locally; a free Neo4j Aura instance should also work (not yet tested).
- A model provider, either:
  - **Ollama** (local, default). Pull a chat model and an embedding model, e.g. `ollama pull gemma3:4b` and `ollama pull nomic-embed-text`.
  - **OpenAI** (an API key; fastest to get going).
- Node.js 18+ to build from source.

## Install (from source)

```bash
git clone https://github.com/Prateik-Lohani-07/noteboi.git
cd noteboi
npm install
docker compose up -d          # Neo4j on bolt://localhost:7687 (user neo4j, password graphrecall)

# build straight into a vault
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/graph-recall" npm run build
```

Then in Obsidian: Settings, Community plugins, turn off Restricted mode, refresh, and enable **Graph Recall**.

1. Settings, Graph Recall: pick a provider (Ollama or OpenAI) and, for OpenAI, paste your API key.
2. Click **Test** under Neo4j. You should see "Neo4j connection OK".
3. Run the command **Graph Recall: Index vault**.
4. Click the ribbon icon, ask a question.

Without `OBSIDIAN_PLUGIN_DIR` the build goes to `./dist`; copy `main.js`, `manifest.json` and `styles.css` into the plugin folder yourself.
`npm run dev` rebuilds on every save.

## Privacy

- With **OpenAI** selected, the text of your notes is sent to OpenAI for embeddings and concept extraction, and retrieved passages are sent with each question.
- With **Ollama**, everything stays on your machine.
- The API key and Neo4j password are stored in plain text in the plugin's `data.json` inside your vault. Exclude that file from any sync or git repository.

## Switching models

Embedding dimensions differ per model (for example 768 for `nomic-embed-text`, 1536 for `text-embedding-3-small`). When you change the
embedding model, the next index detects it, drops the vector index and **deletes the plugin's own nodes** (`Note`, `Chunk`, `Concept`, `Tag`)
before rebuilding. Other data in the same Neo4j database is never touched.

## Optional: voice input

Set a speech-to-text base URL in settings (any OpenAI-compatible `/audio/transcriptions` endpoint, for example OpenAI's own) and a microphone button
appears in the chat box. Ollama has no speech-to-text, so a local setup needs a separate Whisper server. This feature has not been tested inside Obsidian yet.

## Status and known limitations

Tested against a real Neo4j 5 instance with a scripted harness (schema, ingest, hybrid retrieval, graph expansion, incremental re-index, delete, and the
embedding-model switch), with Ollama (`gemma3:1b`, `nomic-embed-text`) and OpenAI (`gpt-4o-mini`, `text-embedding-3-small`), and manually in Obsidian.

- Graph expansion can add loosely related chunks, especially in small vaults. There is no relevance cutoff yet.
- Concept quality depends on the model. A 1B model hallucinates some concepts; larger or hosted models do much better.
- Indexing makes one LLM call per chunk, so a very large vault takes a while on first index. Later runs only re-index changed notes.
- Citations come from the model, so smaller models sometimes omit or misplace them.
- Untested: Neo4j Aura, the microphone button, and mobile (unsupported).

## Code tour

[`docs/code-review.html`](docs/code-review.html) is a guided walkthrough of the source with the parts worth reading first.

| File | Role |
|---|---|
| `src/retrieve.ts` | hybrid search, graph expansion, subgraph for the visualisation |
| `src/ingest.ts` | chunking, concept extraction, graph writes |
| `src/neo4j.ts` | driver, schema, embedding-model switch |
| `src/chatView.ts`, `src/graphView.ts` | chat UI and Cytoscape graph |
| `src/llm.ts` | OpenAI-compatible client (chat, embeddings, transcription) |
| `src/settings.ts` | provider presets and settings tab |

## License

MIT
