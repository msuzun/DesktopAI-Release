/** Speech services are independent of the selected reasoning adapter. */
export interface RecordedSpeech {
  pcm: string[];
  sampleRate: number;
}
export interface SpeechRecognitionEngine {
  transcribe(audio: RecordedSpeech, signal: AbortSignal): Promise<string>;
}
export interface SynthesizedSpeech {
  base64: string;
  sampleRate: number;
}
export interface SpeechSynthesisEngine {
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech>;
}
export interface AudioPlayback {
  play(audio: SynthesizedSpeech, signal: AbortSignal): Promise<void>;
  stop(): void;
}

/** One bounded utterance; no recording files or provider SDK objects. */
export function waveBase64(audio: RecordedSpeech): string {
  if (
    !Number.isInteger(audio.sampleRate) ||
    audio.sampleRate < 8000 ||
    audio.sampleRate > 96000
  )
    throw new Error("Invalid microphone format.");
  if (
    audio.pcm.length > 4096 ||
    audio.pcm.reduce((n, part) => n + part.length, 0) > 5_333_280
  )
    throw new Error("Microphone recording exceeded its limit.");
  const chunks = audio.pcm.map((part) => atob(part));
  const length = chunks.reduce((n, part) => n + part.length, 0);
  if (
    !length ||
    length > 4_000_000 - 44 ||
    chunks.some((part) => part.length % 2)
  )
    throw new Error("Microphone recording exceeded its limit.");
  const bytes = new Uint8Array(44 + length);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, text: string) =>
    [...text].forEach((c, i) => {
      bytes[offset + i] = c.charCodeAt(0);
    });
  label(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  label(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks)
    for (let i = 0; i < chunk.length; i++)
      bytes[offset++] = chunk.charCodeAt(i);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
