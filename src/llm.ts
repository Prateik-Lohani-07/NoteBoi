import type { GraphRecallSettings } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOpts {
  json?: boolean;
  /** Caps output length; stops small models from looping until the server aborts. */
  maxTokens?: number;
  onToken?: (t: string) => void;
  signal?: AbortSignal;
}

/** Thin client for any OpenAI-compatible API (Ollama exposes one at /v1). */
export class Llm {
  constructor(private s: () => GraphRecallSettings) {}

  private headers(extra: Record<string, string> = {}) {
    const { apiKey } = this.s();
    return { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extra };
  }

  private async post(base: string, path: string, body: BodyInit, headers: Record<string, string>, signal?: AbortSignal) {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { method: "POST", body, headers, signal });
    if (!res.ok) throw new Error(`${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    const s = this.s();
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += 32) {
      const res = await this.post(
        s.baseURL,
        "/embeddings",
        JSON.stringify({ model: s.embedModel, input: inputs.slice(i, i + 32) }),
        this.headers({ "Content-Type": "application/json" }),
      );
      const json = await res.json();
      for (const d of json.data) out.push(d.embedding);
    }
    return out;
  }

  async chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
    const s = this.s();
    const stream = !!opts.onToken;
    const res = await this.post(
      s.baseURL,
      "/chat/completions",
      JSON.stringify({
        model: s.chatModel,
        messages,
        stream,
        temperature: 0.2,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      this.headers({ "Content-Type": "application/json" }),
      opts.signal,
    );

    if (!stream) return (await res.json()).choices[0].message.content ?? "";

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const tok = JSON.parse(data).choices?.[0]?.delta?.content;
          if (tok) {
            full += tok;
            opts.onToken!(tok);
          }
        } catch {
          /* partial JSON line, ignore */
        }
      }
    }
    return full;
  }

  get canTranscribe(): boolean {
    return !!this.s().sttBaseURL;
  }

  async transcribe(audio: Blob): Promise<string> {
    const s = this.s();
    const form = new FormData();
    form.append("file", audio, "audio.webm");
    form.append("model", s.sttModel);
    const res = await this.post(s.sttBaseURL, "/audio/transcriptions", form, this.headers());
    return ((await res.json()).text ?? "").trim();
  }
}
