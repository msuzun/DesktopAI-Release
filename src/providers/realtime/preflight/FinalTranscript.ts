// Gemini inputTranscription.finished is the provider's finalization signal.
// Local silence and server turnComplete are not transcript finalization signals.
// Gemini has no input item ID: overlapping unfinished streams are discarded.
export class FinalTranscript {
  private key: string | null = null;
  private text = "";
  private finished = true;
  private ambiguous = false;
  begin(key: string) {
    if (key === this.key) return;
    this.ambiguous = this.key !== null && !this.finished;
    this.key = key;
    this.text = "";
    this.finished = false;
  }
  push(part: { text?: string; finished?: boolean }) {
    if (!this.key || this.finished) return null;
    if (typeof part.text === "string" && !this.ambiguous) {
      if (this.text.length + part.text.length > 8192) this.ambiguous = true;
      else this.text += part.text;
    }
    if (part.finished !== true) return null;
    this.finished = true;
    const result =
      !this.ambiguous && this.text.trim()
        ? { key: this.key, text: this.text }
        : null;
    this.text = "";
    return result;
  }
}
