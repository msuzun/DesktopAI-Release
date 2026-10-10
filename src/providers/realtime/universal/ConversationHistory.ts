import type { ConversationMessage } from "./types.js";

export const historyLimits = { messages: 12, characters: 16000 } as const;

/** Copy only conversational text. Drop oldest whole messages, never truncate text. */
export function normalizeHistory(
  value: readonly ConversationMessage[],
): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  let characters = 0;
  for (const message of value) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.text !== "string" ||
      !message.text.trim()
    )
      continue;
    if (message.text.length > historyLimits.characters) {
      // An oversized message is a continuity boundary; do not attach its reply
      // to an earlier user message after silently dropping the prompt.
      result.length = 0;
      characters = 0;
      continue;
    }
    if (!result.length && message.role === "assistant") continue;
    result.push({ role: message.role, text: message.text });
    characters += message.text.length;
    while (
      result.length > historyLimits.messages ||
      characters > historyLimits.characters
    ) {
      characters -= result.shift()!.text.length;
    }
    while (result[0]?.role === "assistant")
      characters -= result.shift()!.text.length;
  }
  return result;
}

/** Small local ledger for native transcript finalization, independent of wire sessions. */
export class NativeConversationHistory {
  private initial: ConversationMessage[] = [];
  private turns = new Map<
    string,
    { user: string; replies: Map<string, string> }
  >();
  set(messages: readonly ConversationMessage[]) {
    this.initial = normalizeHistory(messages);
    this.turns.clear();
  }
  begin(key: string) {
    if (this.turns.has(key)) return;
    this.turns.set(key, { user: "", replies: new Map() });
    if (this.turns.size > historyLimits.messages)
      this.turns.delete(this.turns.keys().next().value!);
    this.bound();
  }
  user(key: string, text: string) {
    const turn = this.turns.get(key);
    if (!turn) return;
    if (text.length > historyLimits.characters) this.turns.delete(key);
    else turn.user = text;
    this.bound();
  }
  assistant(key: string, id: string, text: string) {
    const turn = this.turns.get(key);
    if (!turn || !text.trim() || text.length > historyLimits.characters) return;
    turn.replies.set(id, text);
    if (turn.replies.size > historyLimits.messages)
      turn.replies.delete(turn.replies.keys().next().value!);
    this.bound();
  }
  removeAssistant(id: string) {
    for (const turn of this.turns.values()) turn.replies.delete(id);
  }
  private bound() {
    const stored = () => [
      ...this.initial.map((message) => message.text),
      ...Array.from(this.turns.values())
        .flatMap((turn) => [turn.user, ...turn.replies.values()])
        .filter(Boolean),
    ];
    let texts = stored();
    while (
      texts.length > historyLimits.messages ||
      texts.reduce((sum, text) => sum + text.length, 0) >
        historyLimits.characters
    ) {
      if (this.initial.length) {
        this.initial.shift();
        while (this.initial[0]?.role === "assistant") this.initial.shift();
      } else {
        this.turns.delete(this.turns.keys().next().value!);
      }
      texts = stored();
    }
  }
  get(): ConversationMessage[] {
    const messages = [...this.initial];
    for (const turn of this.turns.values()) {
      // Assistant text cannot be attached to a different prompt when STT is late.
      if (!turn.user.trim()) continue;
      messages.push({ role: "user", text: turn.user });
      for (const text of turn.replies.values())
        messages.push({ role: "assistant", text });
    }
    return normalizeHistory(messages);
  }
}
