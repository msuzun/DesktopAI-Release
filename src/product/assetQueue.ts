import { memoryApi } from "./memoryApi";

// At most two asset IPC requests are active. Metadata/voice operations retain
// room in the bounded native queue; offscreen/unmounted work is discarded.
let active = 0;
const pending: (() => void)[] = [];
function drain() {
  while (active < 2 && pending.length) pending.shift()!();
}
export function loadMemoryAsset(
  id: string,
  thumbnail: boolean,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = pending.indexOf(run);
      if (index >= 0) pending.splice(index, 1);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const run = () => {
      if (signal.aborted) {
        abort();
        return;
      }
      active++;
      void memoryApi
        .asset(id, thumbnail)
        .then(resolve, reject)
        .finally(() => {
          active--;
          signal.removeEventListener("abort", abort);
          drain();
        });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    pending.push(run);
    drain();
  });
}
