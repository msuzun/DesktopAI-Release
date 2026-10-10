import spec from "./action-spec.json" with { type: "json" };
import { untilCancelled } from "../universal/cancellation.js";

export interface ActionStatus {
  enabled: boolean;
  executionAvailable: boolean;
  pendingCandidates: number;
  generation: number;
}
export interface ActionCandidate {
  readonly id: string;
  readonly digest: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly kind: "application" | "terminal" | "command" | "script";
  readonly target: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly content?: string;
  readonly expiresAtUnixMs: number;
}
export type ActionCandidateIdentity = Pick<
  ActionCandidate,
  "id" | "digest" | "epoch" | "turnId"
>;
export interface ActionSnapshot {
  status: ActionStatus;
  candidate: ActionCandidate | null;
  confirming: boolean;
  message: string | null;
}
export interface ActionTurnResult {
  handled: boolean;
  message?: string;
}
export type ActionTurnHandler = (
  text: string,
  turnId: string,
  signal: AbortSignal,
) => Promise<ActionTurnResult>;
type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
interface NativeOutcome {
  handled: boolean;
  code: string;
  turnId: string;
  target?: string;
  candidate?: ActionCandidate;
}

function normalized(text: string) {
  return text
    .trim()
    .replace(/[.!?]+$/, "")
    .trim()
    .replaceAll("’", "'")
    .replaceAll("İ", "i")
    .toLowerCase();
}
/** A narrow native policy grammar, not authority from a classifier or screen content. */
export function supportedActionRequest(text: string): string | null {
  if (text.length > 8192) return null;
  const input = normalized(text);
  return (
    spec.targets.find((target) => target.phrases.includes(input))?.id ?? null
  );
}
function unresolvedRequest(text: string) {
  return spec.unresolved.includes(normalized(text));
}
const messages = {
  en: {
    disabled:
      "Actions are off. Enable Actions in settings to review a supported action request.",
    unavailable:
      "Actions are temporarily unavailable. You can still ask questions.",
    gate: "Execution is unavailable while action safety acceptance is pending. You can review or cancel this candidate.",
    ambiguous:
      "Specify one supported application or the exact synthetic command or script. No action was taken.",
    denied:
      "This request did not resolve to one supported action. No action was taken.",
    missing:
      "The requested application was not found, or more than one installation matched.",
    failed: "The action could not be started.",
    launched: "The confirmed action started successfully.",
    review:
      "Review the exact action in the confirmation dialog. Only its Confirm button can approve execution.",
    stale:
      "This approval is stale or does not match the current action. No action was taken.",
    cancelled: "The action was cancelled. No action was taken.",
  },
  tr: {
    disabled:
      "Eylemler kapalı. Desteklenen bir eylemi incelemek için ayarlardan Eylemleri etkinleştirin.",
    unavailable:
      "Eylemler şu anda kullanılamıyor. Soru sormaya devam edebilirsiniz.",
    gate: "Eylem güvenliği kabulü beklenirken yürütme kullanılamaz. Bu adayı inceleyebilir veya iptal edebilirsiniz.",
    ambiguous:
      "Desteklenen tek bir uygulama veya tam sentetik komut ya da script isteği belirtin. İşlem yapılmadı.",
    denied:
      "İstek, desteklenen tek bir eylem olarak doğrulanamadı. İşlem yapılmadı.",
    missing: "İstenen uygulama bulunamadı veya birden fazla kurulum eşleşti.",
    failed: "Eylem başlatılamadı.",
    launched: "Onaylanan eylem başarıyla başlatıldı.",
    review:
      "Onay penceresindeki eylemin tamamını inceleyin. Yalnızca Onayla düğmesi yürütmeyi onaylayabilir.",
    stale: "Bu onay eski veya geçerli eylemle eşleşmiyor. İşlem yapılmadı.",
    cancelled: "Eylem iptal edildi. İşlem yapılmadı.",
  },
};
function sameCandidate(a: ActionCandidateIdentity, b: ActionCandidateIdentity) {
  return (
    a.id === b.id &&
    a.digest === b.digest &&
    a.epoch === b.epoch &&
    a.turnId === b.turnId
  );
}
function validCandidate(
  candidate: ActionCandidate | undefined,
  epoch: number,
  turnId: string,
  target: string,
) {
  return (
    !!candidate &&
    candidate.epoch === epoch &&
    candidate.turnId === turnId &&
    candidate.target === target &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.digest === "string" &&
    /^[a-f0-9]{64}$/i.test(candidate.digest) &&
    typeof candidate.executable === "string" &&
    candidate.executable.length > 0 &&
    typeof candidate.executableSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(candidate.executableSha256) &&
    typeof candidate.workingDirectory === "string" &&
    ["application", "terminal", "command", "script"].includes(candidate.kind) &&
    Array.isArray(candidate.args) &&
    candidate.args.every((arg) => typeof arg === "string") &&
    (candidate.content === undefined ||
      typeof candidate.content === "string") &&
    Number.isFinite(candidate.expiresAtUnixMs) &&
    candidate.expiresAtUnixMs > Date.now()
  );
}

/** Application-owned action boundary. Classification only proposes; a UI click confirms immutable identity. */
export class ActionIntentEngine {
  private status: ActionStatus = {
    enabled: false,
    executionAvailable: false,
    pendingCandidates: 0,
    generation: 0,
  };
  private candidate: ActionCandidate | null = null;
  private confirming = false;
  private message: string | null = null;
  private generation = 0;
  private activeEpoch: number | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private detachAbort: (() => void) | undefined;
  private listeners = new Set<(snapshot: ActionSnapshot) => void>();
  constructor(
    private invoke: Invoke,
    private language: () => string = () => "en",
  ) {}
  private copy() {
    return messages[this.language().startsWith("tr") ? "tr" : "en"];
  }
  getSnapshot(): ActionSnapshot {
    return {
      status: { ...this.status },
      candidate: this.candidate,
      confirming: this.confirming,
      message: this.message,
    };
  }
  subscribe(listener: (snapshot: ActionSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
  private clearPending() {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.candidate = null;
    this.activeEpoch = undefined;
    this.confirming = false;
    this.status = { ...this.status, pendingCandidates: 0 };
  }
  cancel() {
    ++this.generation;
    const epoch = this.activeEpoch;
    this.clearPending();
    this.message = null;
    this.publish();
    if (epoch !== undefined)
      void this.invoke("actions_cancel", { epoch }).catch(() => {});
  }
  async configure(enabled: boolean) {
    this.cancel();
    const generation = this.generation;
    // Revoke locally before awaiting IPC so no text crosses the remote boundary while off.
    this.status = { ...this.status, enabled: false };
    this.publish();
    const result = await this.invoke<ActionStatus>("actions_configure", {
      enabled,
    });
    if (generation === this.generation) {
      this.status = result;
      this.publish();
    }
    return { ...this.status };
  }
  async refresh() {
    const generation = this.generation;
    const result = await this.invoke<ActionStatus>("actions_status");
    if (generation === this.generation) {
      this.status = result;
      if (!result.enabled) this.cancel();
      this.publish();
    }
    return { ...this.status };
  }
  reject(identity: ActionCandidateIdentity) {
    if (!this.candidate || !sameCandidate(this.candidate, identity)) return;
    this.cancel();
    this.message = this.copy().cancelled;
    this.publish();
  }
  async confirm(identity: ActionCandidateIdentity): Promise<ActionTurnResult> {
    const copy = this.copy(),
      candidate = this.candidate;
    if (
      !candidate ||
      !sameCandidate(candidate, identity) ||
      this.confirming ||
      candidate.expiresAtUnixMs <= Date.now()
    )
      return { handled: true, message: copy.stale };
    if (!this.status.enabled) return { handled: true, message: copy.disabled };
    if (!this.status.executionAvailable)
      return { handled: true, message: copy.gate };
    const generation = this.generation;
    // Once submitted, native expiry/policy owns the outcome. A UI timer must not
    // report cancellation while a valid approved execution is returning.
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.confirming = true;
    this.publish();
    let message = copy.unavailable;
    try {
      // Never send executable/content from the UI: native code uses its stored immutable candidate.
      const result = await this.invoke<NativeOutcome>("actions_confirm", {
        epoch: candidate.epoch,
        turnId: candidate.turnId,
        candidateId: candidate.id,
        digest: candidate.digest,
      });
      if (result.turnId === candidate.turnId)
        message = this.outcomeMessage(result.code);
    } catch {
      message = copy.unavailable;
    }
    if (
      generation !== this.generation ||
      !this.candidate ||
      !sameCandidate(this.candidate, candidate)
    )
      return { handled: true, message: copy.stale };
    const epoch = this.activeEpoch;
    this.clearPending();
    this.message = message;
    this.publish();
    if (epoch !== undefined)
      void this.invoke("actions_cancel", { epoch }).catch(() => {});
    return { handled: true, message };
  }
  private outcomeMessage(code: string) {
    const copy = this.copy();
    return code === "ACTION_STARTED"
      ? copy.launched
      : code === "ACTION_RELEASE_GATE"
        ? copy.gate
        : code === "ACTION_TARGET_NOT_FOUND"
          ? copy.missing
          : code === "ACTION_EXECUTION_FAILED"
            ? copy.failed
            : code === "ACTION_DENIED"
              ? copy.denied
              : /STALE|EXPIRED|MISMATCH/.test(code)
                ? copy.stale
                : copy.unavailable;
  }
  readonly handle: ActionTurnHandler = async (text, turnId, signal) => {
    // Any new utterance supersedes a pending approval, including ordinary conversation or "yes".
    this.cancel();
    const target = supportedActionRequest(text),
      unresolved = unresolvedRequest(text);
    if (!target && !unresolved) return { handled: false };
    const copy = this.copy();
    if (unresolved) return { handled: true, message: copy.ambiguous };
    if (!this.status.enabled) return { handled: true, message: copy.disabled };
    const generation = this.generation;
    let epoch: number | undefined;
    const cancel = () => {
      if (generation === this.generation) this.cancel();
      else if (epoch !== undefined)
        void this.invoke("actions_cancel", { epoch }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", cancel);
    try {
      signal.throwIfAborted();
      // Do not abandon begin: even a late epoch must be cancelled if its turn ended.
      epoch = await this.invoke<number>("actions_begin", { turnId });
      if (signal.aborted || generation !== this.generation) {
        void this.invoke("actions_cancel", { epoch }).catch(() => {});
        signal.throwIfAborted();
        return { handled: true, message: copy.unavailable };
      }
      this.activeEpoch = epoch;
      const result = await untilCancelled(
        this.invoke<NativeOutcome>("actions_classify", { epoch, text }),
        signal,
      );
      if (generation !== this.generation || result.turnId !== turnId)
        return { handled: true, message: copy.unavailable };
      if (
        result.code === "ACTION_CONFIRMATION_REQUIRED" &&
        validCandidate(result.candidate, epoch, turnId, target!)
      ) {
        this.candidate = Object.freeze({
          ...result.candidate!,
          args: Object.freeze([...result.candidate!.args]),
        });
        this.status = { ...this.status, pendingCandidates: 1 };
        const identity = this.candidate;
        this.expiry = setTimeout(
          () => this.reject(identity),
          Math.min(identity.expiresAtUnixMs - Date.now(), 2_147_483_647),
        );
        this.publish();
        return { handled: true, message: copy.review };
      }
      // A classifier is never allowed to claim execution succeeded.
      return {
        handled: true,
        message:
          result.code === "ACTION_STARTED"
            ? copy.denied
            : this.outcomeMessage(result.code),
      };
    } catch {
      signal.throwIfAborted();
      return { handled: true, message: copy.unavailable };
    } finally {
      if (generation === this.generation && !this.candidate) this.cancel();
      if (!this.candidate || this.candidate.epoch !== epoch)
        signal.removeEventListener("abort", cancel);
    }
  };
}
