import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type NoteBoiPlugin from "../main";
import { buildPrompt, retrieve } from "./retrieve";
import { GraphPanel } from "./graphView";
import { Recorder } from "./voice";

export const VIEW_TYPE = "noteboi-chat";

export class ChatView extends ItemView {
  private log!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private mic!: HTMLButtonElement;
  private send!: HTMLButtonElement;
  private recorder = new Recorder();
  private panels: GraphPanel[] = [];
  private busy = false;

  constructor(leaf: WorkspaceLeaf, private plugin: NoteBoiPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "NoteBoi";
  }
  getIcon() {
    return "git-fork";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("noteboi");

    this.log = root.createDiv("gr-log");
    this.log.createDiv({
      cls: "gr-hint",
      text: "Ask anything about your notes. Answers cite their sources, and the graph shows how they were found.",
    });

    const bar = root.createDiv("gr-input");
    this.input = bar.createEl("textarea", { attr: { placeholder: "What did I learn about…?", rows: "2" } });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.ask();
      }
    });

    const buttons = bar.createDiv("gr-buttons");
    if (this.plugin.llm().canTranscribe) {
      this.mic = buttons.createEl("button", { text: "🎙", attr: { "aria-label": "Dictate" } });
      this.mic.addEventListener("click", () => void this.toggleMic());
    }
    this.send = buttons.createEl("button", { text: "Ask", cls: "mod-cta" });
    this.send.addEventListener("click", () => void this.ask());
  }

  async onClose() {
    this.panels.forEach((p) => p.destroy());
    this.panels = [];
  }

  private async toggleMic() {
    try {
      if (!this.recorder.recording) {
        await this.recorder.start();
        this.mic.addClass("gr-recording");
        return;
      }
      this.mic.removeClass("gr-recording");
      const blob = await this.recorder.stop();
      this.mic.disabled = true;
      const text = await this.plugin.llm().transcribe(blob);
      this.input.value = (this.input.value + " " + text).trim();
      this.input.focus();
    } catch (e) {
      new Notice(`Voice input failed: ${(e as Error).message}`);
    } finally {
      this.mic.disabled = false;
    }
  }

  private async ask() {
    const question = this.input.value.trim();
    if (!question || this.busy) return;
    this.busy = true;
    this.send.disabled = true;
    this.input.value = "";

    const q = this.log.createDiv("gr-msg gr-user");
    q.setText(question);
    const a = this.log.createDiv("gr-msg gr-assistant");
    a.setText("Searching your graph…");
    this.log.scrollTop = this.log.scrollHeight;

    try {
      const graph = this.plugin.graph();
      const llm = this.plugin.llm();
      const result = await retrieve(graph, llm, question);

      if (result.passages.length === 0) {
        a.setText("Nothing in the index matches. Have you run “Index vault” yet?");
        return;
      }

      a.empty();
      let answer = "";
      const body = a.createDiv("gr-answer");
      await llm.chat(buildPrompt(question, result.passages), {
        onToken: (t) => {
          answer += t;
          body.setText(answer);
          this.log.scrollTop = this.log.scrollHeight;
        },
      });
      body.empty();
      await MarkdownRenderer.render(this.app, answer, body, "", this);
      body.querySelectorAll("a.internal-link").forEach((link) =>
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.app.workspace.openLinkText(link.getAttribute("data-href") ?? "", "", false);
        }),
      );

      const details = a.createEl("details", { cls: "gr-graph-wrap" });
      details.open = true;
      details.createEl("summary", {
        text: `Graph: ${result.passages.filter((p) => p.role === "seed").length} direct hits, ${result.passages.filter((p) => p.role === "expanded").length} found by traversal`,
      });
      const legend = details.createDiv("gr-legend");
      legend.innerHTML =
        '<span style="color:#4c8bf5">● search hit</span> <span style="color:#f59e0b">● graph expansion</span> <span style="color:#10b981">◆ shared concept</span> <span style="color:#9ca3af">▬ note</span>';
      const canvas = details.createDiv("gr-graph");
      const panel = new GraphPanel(canvas, (node) => {
        if (node.path) {
          const target = node.heading ? `${node.path}#${node.heading}` : node.path;
          void this.app.workspace.openLinkText(target, "", false);
        }
      });
      this.panels.push(panel);
      panel.render(result.nodes, result.edges);
    } catch (e) {
      a.setText(`Error: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.send.disabled = false;
      this.log.scrollTop = this.log.scrollHeight;
    }
  }
}
