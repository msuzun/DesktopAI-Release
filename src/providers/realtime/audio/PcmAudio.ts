import { microphoneError, VoiceError } from "../errors.js";
import { playbackLimits, PlaybackQueueFullError } from "./playbackLimits.js";
// Transport-independent mono PCM16 capture/playback. Browser handles sample-rate conversion.
export class PcmAudio {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private next = 0;
  private closed = false;
  private muted = false;
  constructor(private readonly activity: (playing: boolean) => void) {}
  async start(send: (data: string, rate: number) => void, failure: () => void) {
    const context = new AudioContext({ sampleRate: 16000 });
    this.context = context;
    await context.resume();
    if (this.closed) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw microphoneError(error);
    }
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    if (!stream.getAudioTracks().length)
      throw new VoiceError("No microphone audio track available.");
    stream.getAudioTracks().forEach((t) => (t.onended = failure));
    await context.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
    if (this.closed) return;
    this.worklet = new AudioWorkletNode(context, "pcm-capture");
    this.worklet.onprocessorerror = failure;
    this.worklet.port.onmessage = (event) => {
      if (this.closed || this.muted) return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      send(btoa(String.fromCharCode(...bytes)), context.sampleRate);
    };
    this.input = context.createMediaStreamSource(stream);
    this.input.connect(this.worklet);
    this.worklet.connect(context.destination); // Processor emits silence to prevent local feedback.
  }
  play(data: string, rate: number) {
    const context = this.context;
    if (this.closed || !context || context.state !== "running")
      throw new VoiceError(
        "Audio output is not running. Restart the voice connection to restore playback.",
      );
    if (data.length > playbackLimits.maxChunkBase64Characters)
      throw new PlaybackQueueFullError();
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.length % 2 || !bytes.length)
      throw new VoiceError("Invalid PCM audio received.");
    if (!Number.isFinite(rate) || rate <= 0)
      throw new VoiceError("Invalid PCM sample rate.");
    const start = Math.max(context.currentTime, this.next);
    if (
      start + bytes.length / 2 / rate - context.currentTime >
        playbackLimits.maxQueuedSeconds ||
      this.sources.size >= playbackLimits.maxScheduledSources
    )
      throw new PlaybackQueueFullError();
    const buffer = context.createBuffer(1, bytes.length / 2, rate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++)
      samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.next = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (!this.sources.size) this.activity(false);
    };
    try {
      source.start(start);
    } catch (error) {
      source.onended = null;
      this.sources.delete(source);
      source.disconnect();
      this.next = start;
      throw error;
    }
    this.activity(true);
  }
  outputState() {
    return this.context?.state ?? "unavailable";
  }
  interrupt() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.next = 0;
    this.activity(false);
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }
  close() {
    this.closed = true;
    this.interrupt();
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    this.input?.disconnect();
    this.worklet?.disconnect();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
    }
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}
