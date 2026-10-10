import { untilCancelled } from "./cancellation.js";

/** Canonical response text stays untouched; this copy alone is spoken. */
export function speechText(text: string): string {
  return text
    .replace(/```[^`\r\n]*\r?\n/g, " ")
    .replace(/```/g, " ")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s{0,3}#{1,6}\s/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class SpeechChunker {
  private buffer = "";
  private since = 0;
  constructor(
    private now = () => performance.now(),
    private max = 280,
  ) {}
  add(text: string): string[] {
    if (!this.buffer) this.since = this.now();
    this.buffer += text;
    return this.take(false);
  }
  due(): string[] {
    return this.buffer.length >= 40 && this.now() - this.since >= 700
      ? this.take(true)
      : [];
  }
  finish(): string[] {
    return this.take(true);
  }
  private take(flush: boolean): string[] {
    const result: string[] = [];
    while (this.buffer.length) {
      // Whitespace after punctuation avoids splitting decimal numbers and URLs.
      const match = /[.!?;。！？](?:["'”’)]*)(?:\s|$)/u.exec(this.buffer);
      let end = match && match.index >= 24 ? match.index + match[0].length : 0;
      if (!end || end > this.max) {
        if (this.buffer.length > this.max) {
          end = this.buffer.lastIndexOf(" ", this.max);
          if (end < 40) end = this.max;
          const code = this.buffer.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) --end;
        } else if (flush) end = this.buffer.length;
        else break;
      }
      const text = speechText(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
      this.since = this.now();
      if (text) result.push(text);
    }
    return result;
  }
}

/** Synthesis and playback have a single owner. Overflow is explicit, never silent. */
export class SpeechQueue {
  private queued: string[] = [];
  private active: Promise<void> | null = null;
  private error: unknown;
  private characters = 0;
  constructor(
    private speak: (text: string) => Promise<void>,
    private signal: AbortSignal,
  ) {
    signal.addEventListener(
      "abort",
      () => {
        this.queued = [];
        this.characters = 0;
      },
      { once: true },
    );
  }
  push(text: string) {
    if (this.signal.aborted) return;
    if (this.error) throw this.error;
    if (this.queued.length >= 32 || this.characters + text.length > 8000)
      throw new Error("Speech response exceeded its queue limit.");
    this.queued.push(text);
    this.characters += text.length;
    this.active ??= Promise.resolve().then(() => this.run());
  }
  private async run() {
    try {
      while (!this.signal.aborted && this.queued.length) {
        const text = this.queued.shift()!;
        this.characters -= text.length;
        await untilCancelled(
          Promise.resolve().then(() => this.speak(text)),
          this.signal,
        );
      }
    } catch (error) {
      this.error = error;
      this.queued = [];
      this.characters = 0;
    } finally {
      this.active = null;
      if (this.signal.aborted) {
        this.queued = [];
        this.characters = 0;
      }
    }
  }
  async drain() {
    if (this.active) await untilCancelled(this.active, this.signal);
    this.signal.throwIfAborted();
    if (this.error) throw this.error;
  }
}
