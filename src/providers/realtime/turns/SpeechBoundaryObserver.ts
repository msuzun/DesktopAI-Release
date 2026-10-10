import { PcmTurnDetector } from "./PcmTurnDetector.js";

// Observe the already-authorized WebRTC microphone. Provider VAD still controls
// speech completion; this only reserves a local visual moment during its delay.
export function observeSpeechBoundary(
  stream: MediaStream,
  boundary: (at: number | null) => void,
  unavailable: () => void = () => {},
): () => void {
  const context = new AudioContext({ sampleRate: 16000 });
  let closed = false;
  let input: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  const detector = new PcmTurnDetector(
    () => boundary(null),
    () => {},
    () => {},
    () => false,
    boundary,
  );
  const stop = () => {
    if (closed) return;
    closed = true;
    if (worklet) worklet.port.onmessage = null;
    worklet?.disconnect();
    input?.disconnect();
    void context.close().catch(() => {});
  };
  const fail = () => {
    if (!closed) unavailable();
    stop();
  };
  void (async () => {
    await context.resume();
    await context.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
    if (closed) return;
    worklet = new AudioWorkletNode(context, "pcm-capture");
    worklet.port.onmessage = (event) => {
      if (closed) return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      detector.push(btoa(String.fromCharCode(...bytes)), context.sampleRate);
    };
    worklet.onprocessorerror = fail;
    input = context.createMediaStreamSource(stream);
    input.connect(worklet);
    worklet.connect(context.destination); // Worklet output is silence.
  })().catch(fail);
  return stop;
}
