import { VoiceError } from "../errors.js";

/** Local transport drain only; Gemini does not acknowledge individual frames. */
export function waitForDrain(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount">,
  signal: AbortSignal,
  active: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(
      () => finish(new VoiceError("Visual transport did not drain in time.")),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      clearTimeout(poll);
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new VoiceError("Visual request cancelled."));
    const check = () => {
      if (signal.aborted || !active() || socket.readyState !== 1)
        return abort();
      if (!socket.bufferedAmount) return finish();
      poll = setTimeout(check, 20);
    };
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
