import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { ChatView, VIEW_TYPE } from "./src/chatView";
import { Indexer } from "./src/ingest";
import { Llm } from "./src/llm";
import { Graph } from "./src/neo4j";
import { DEFAULT_SETTINGS, NoteBoiSettings, NoteBoiSettingTab } from "./src/settings";

export default class NoteBoiPlugin extends Plugin {
  settings!: NoteBoiSettings;
  private _graph!: Graph;
  private _llm!: Llm;
  private indexer!: Indexer;
  private timers = new Map<string, number>();

  graph() {
    return this._graph;
  }
  llm() {
    return this._llm;
  }

  async onload() {
    await this.loadSettings();
    this._graph = new Graph(() => this.settings);
    this._llm = new Llm(() => this.settings);
    this.indexer = new Indexer(this.app, this._graph, this._llm, () => this.settings);

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("git-fork", "NoteBoi", () => void this.activateView());
    this.addSettingTab(new NoteBoiSettingTab(this.app, this));

    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateView() });
    this.addCommand({ id: "index-vault", name: "Index vault", callback: () => void this.indexVault() });
    this.addCommand({
      id: "index-current",
      name: "Re-index current note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) void this.run(() => this.indexer.indexFile(f));
        return true;
      },
    });

    // vault events only start once the layout is ready, so startup doesn't trigger a flood of "create"s
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("modify", (f) => this.schedule(f)));
      this.registerEvent(this.app.vault.on("create", (f) => this.schedule(f)));
      this.registerEvent(
        this.app.vault.on("delete", (f) => {
          if (this.settings.autoIndex && f instanceof TFile && f.extension === "md") {
            void this.run(() => this.indexer.deleteNote(f.path));
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (f, oldPath) => {
          if (this.settings.autoIndex && f instanceof TFile && f.extension === "md") {
            void this.run(async () => {
              await this.indexer.deleteNote(oldPath);
              await this.indexer.indexFile(f);
            });
          }
        }),
      );
    });
  }

  async onunload() {
    this.timers.forEach((t) => window.clearTimeout(t));
    await this._graph.close();
  }

  private schedule(f: TAbstractFile) {
    if (!this.settings.autoIndex || !(f instanceof TFile) || f.extension !== "md") return;
    window.clearTimeout(this.timers.get(f.path));
    this.timers.set(
      f.path,
      window.setTimeout(() => {
        this.timers.delete(f.path);
        void this.run(() => this.indexer.indexFile(f));
      }, 5000),
    );
  }

  private async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      console.error("NoteBoi:", e);
      new Notice(`NoteBoi: ${(e as Error).message}`);
    }
  }

  indexVault() {
    return this.run(() => this.indexer.indexVault());
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
