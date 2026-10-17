import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GraphRecallPlugin from "../main";

export type Provider = "ollama" | "openai" | "custom";

export interface GraphRecallSettings {
  provider: Provider;
  baseURL: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  sttBaseURL: string; // stt - Speech to text
  sttModel: string;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  neo4jDatabase: string;
  autoIndex: boolean;
}

type Preset = Pick<
  GraphRecallSettings,
  "baseURL" | "apiKey" | "chatModel" | "embedModel" | "sttBaseURL" | "sttModel"
>;

export const PRESETS: Record<Exclude<Provider, "custom">, Preset> = {
  ollama: {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    chatModel: "llama3.1",
    embedModel: "nomic-embed-text",
    // Ollama has no speech-to-text; point this at a local OpenAI-compatible Whisper server (optional)
    sttBaseURL: "",
    sttModel: "whisper-1",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    chatModel: "gpt-4o-mini",
    embedModel: "text-embedding-3-small",
    sttBaseURL: "https://api.openai.com/v1",
    sttModel: "whisper-1",
  },
};

export const DEFAULT_SETTINGS: GraphRecallSettings = {
  provider: "ollama",
  ...PRESETS.ollama,
  neo4jUri: "bolt://localhost:7687",
  neo4jUser: "neo4j",
  neo4jPassword: "graphrecall",
  neo4jDatabase: "",
  autoIndex: true,
};

export class GraphRecallSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GraphRecallPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };

    containerEl.createEl("h2", { text: "Model provider" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Ollama for local use, OpenAI for demos. Both use the OpenAI-compatible API.")
      .addDropdown((d) =>
        d
          .addOption("ollama", "Ollama (local)")
          .addOption("openai", "OpenAI")
          .addOption("custom", "Custom")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as Provider;
            if (v !== "custom") Object.assign(s, PRESETS[v as Exclude<Provider, "custom">]);
            await save();
            this.display();
          }),
      );

    const text = (name: string, key: keyof GraphRecallSettings, desc = "", secret = false) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          if (secret) t.inputEl.type = "password";
          t.setValue(String(s[key] ?? "")).onChange(async (v) => {
            (s[key] as string) = v.trim();
            if (s.provider !== "custom" && key in PRESETS.ollama) s.provider = "custom";
            await save();
          });
        });

    text("Base URL", "baseURL");
    text("API key", "apiKey", "", true);
    text("Chat model", "chatModel");
    text(
      "Embedding model",
      "embedModel",
      "Changing this requires a full re-index (vector dimensions differ per model).",
    );

    containerEl.createEl("h2", { text: "Voice (optional)" });
    text(
      "Speech-to-text base URL",
      "sttBaseURL",
      "OpenAI-compatible /audio/transcriptions server. Leave empty to hide the mic button.",
    );
    text("Speech-to-text model", "sttModel");

    containerEl.createEl("h2", { text: "Neo4j" });
    text("Bolt URI", "neo4jUri", "e.g. bolt://localhost:7687 or neo4j+s://xxxx.databases.neo4j.io");
    text("Username", "neo4jUser");
    text("Password", "neo4jPassword", "", true);
    text("Database", "neo4jDatabase", "Leave empty for the default database.");

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            await this.plugin.graph().verify();
            new Notice("Neo4j connection OK");
          } catch (e) {
            new Notice(`Neo4j connection failed: ${(e as Error).message}`);
          }
        }),
      );

    containerEl.createEl("h2", { text: "Indexing" });
    new Setting(containerEl)
      .setName("Re-index changed notes automatically")
      .addToggle((t) =>
        t.setValue(s.autoIndex).onChange(async (v) => {
          s.autoIndex = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Index vault")
      .setDesc("Indexes new and changed notes. Rebuilds everything if the embedding model changed.")
      .addButton((b) =>
        b
          .setButtonText("Index now")
          .setCta()
          .onClick(() => this.plugin.indexVault()),
      );
  }
}
