export interface CompanionPorts {
  startVoice(): Promise<void>;
  voiceConnected(): boolean;
  stopVoice(): void;
  startVisual(): Promise<void>;
  stopVisual(): Promise<void>;
  grantVisual(): Promise<void>;
  revokeVisual(): void;
  enableFresh(): Promise<void>;
  allowScreen(enabled: boolean): void;
  ready(): void;
}
export interface CompanionSnapshot {
  state: "Idle" | "Starting" | "Active" | "Stopping" | "Error";
  awareness: boolean;
  error: string | null;
}

/** Coordinates existing subsystems; no provider protocol or capture logic. */
export class CompanionSession {
  private snapshot: CompanionSnapshot = {
    state: "Idle",
    awareness: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  constructor(private ports: CompanionPorts) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<CompanionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  setAwareness(enabled: boolean) {
    // Off closes the upload gate synchronously, including during startup.
    if (!enabled) {
      this.ports.allowScreen(false);
      this.ports.revokeVisual();
    }
    if (enabled && !["Idle", "Error"].includes(this.snapshot.state)) return;
    this.publish({ awareness: enabled });
    if (!enabled && ["Starting", "Active"].includes(this.snapshot.state))
      void this.stop();
  }
  start(): Promise<void> {
    if (!["Idle", "Error"].includes(this.snapshot.state)) return this.pending;
    const id = ++this.sequence;
    const awareness = this.snapshot.awareness;
    this.ports.allowScreen(awareness);
    this.publish({ state: "Starting", error: null });
    const current = () => id === this.sequence;
    this.pending = (async () => {
      let stage = "voice";
      try {
        await this.ports.startVoice();
        if (!current()) return;
        if (!this.ports.voiceConnected()) throw new Error();
        if (awareness) {
          stage = "screen";
          await this.ports.startVisual();
          if (!current()) return;
          await this.ports.grantVisual();
          if (!current()) return;
          await this.ports.enableFresh();
          if (!current()) return;
          if (!this.ports.voiceConnected()) throw new Error();
        }
        this.ports.ready();
        this.publish({ state: "Active" });
      } catch {
        if (!current()) return;
        this.ports.allowScreen(false);
        this.ports.stopVoice();
        this.ports.revokeVisual();
        let cleanupFailed = false;
        try {
          await this.ports.stopVisual();
        } catch {
          cleanupFailed = true;
        }
        if (current())
          this.publish({
            state: "Error",
            error: cleanupFailed
              ? "Screen capture could not be stopped. Close and reopen the app."
              : stage === "screen"
                ? "Screen awareness could not start. Try again, or turn it off to use voice only."
                : "Could not connect. Check your API key, microphone permission and internet connection.",
          });
      }
    })();
    return this.pending;
  }
  stop(error: string | null = null): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.sequence;
    this.ports.allowScreen(false);
    this.ports.stopVoice();
    this.ports.revokeVisual();
    this.publish({ state: "Stopping", error });
    const pending = this.pending;
    this.stopping = (async () => {
      await pending;
      try {
        // A late native start must finish before the final stop command.
        await this.ports.stopVisual();
        this.publish({ state: error ? "Error" : "Idle", error });
      } catch {
        this.publish({
          state: "Error",
          error:
            "Screen capture could not be stopped. Close and reopen the app.",
        });
      } finally {
        this.stopping = null;
      }
    })();
    return this.stopping;
  }
}
