// Only used on a Gemini connection negotiated with automatic VAD disabled.
// Bounded 400 ms preroll; 160 ms onset, 320 ms to interrupt; 600 ms trailing silence.
export interface VoiceOnset {
  rms: number;
  threshold: number;
  sustainedMs: number;
  interrupting: boolean;
}
export class PcmTurnDetector {
  private pre: { data: string; rate: number; ms: number }[] = [];
  private preMs = 0;
  private onset = 0;
  private silence = 0;
  private speaking = false;
  private noiseFloor = 0;
  private peak = 0;
  private quietEnergy = 0;
  private quietFrames = 0;
  private boundaryAt: number | null = null;
  private boundaryPublished = false;
  constructor(
    private start: (onset: VoiceOnset) => void,
    private audio: (data: string, rate: number) => void,
    private end: () => void,
    private interrupting: () => boolean = () => false,
    private boundary?: (completedMonotonicAt: number | null) => void,
  ) {}
  push(data: string, rate: number) {
    const raw = atob(data);
    if (!rate || !raw.length || raw.length % 2) return;
    let sum = 0,
      mean = 0;
    for (let i = 0; i < raw.length; i += 2) {
      let v = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8);
      if (v >= 32768) v -= 65536;
      sum += (v / 32768) ** 2;
      mean += v / 32768;
    }
    const ms = (raw.length / 2 / rate) * 1000;
    const count = raw.length / 2;
    // DC offset is not voice activity. Measure alternating signal energy.
    const rms = Math.sqrt(Math.max(0, sum / count - (mean / count) ** 2));
    if (!this.speaking && rms < this.noiseFloor)
      this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
    const interrupting = !this.speaking && this.interrupting();
    // An unconfirmed sound cannot cancel an existing response. Interruption
    // requires stronger, longer evidence than starting from idle.
    const onsetThreshold = Math.max(
      interrupting ? 0.014 : 0.008,
      this.noiseFloor * 2.5,
    );
    const voiced =
      rms >=
      (this.speaking
        ? Math.max(onsetThreshold, this.peak * 0.25)
        : onsetThreshold);
    if (!this.speaking) {
      this.pre.push({ data, rate, ms });
      this.preMs += ms;
      while (this.preMs > 400 && this.pre.length > 1)
        this.preMs -= this.pre.shift()!.ms;
      // Brief low-energy consonants must not restart confirmation from zero.
      // Isolated clicks still decay away before they can accumulate a turn.
      this.onset = voiced ? this.onset + ms : Math.max(0, this.onset - ms * 2);
      if (this.onset < (interrupting ? 320 : 160)) return;
      this.speaking = true;
      this.peak = rms;
      this.quietEnergy = this.quietFrames = 0;
      this.silence = 0;
      this.start({
        rms,
        threshold: onsetThreshold,
        sustainedMs: this.onset,
        interrupting,
      });
      for (const p of this.pre) this.audio(p.data, p.rate);
      this.pre = [];
      this.preMs = 0;
      return;
    }
    this.audio(data, rate);
    this.peak = Math.max(rms, this.peak * 0.995);
    if (voiced && this.silence > 0) {
      if (this.boundaryPublished) this.boundary?.(null);
      this.boundaryPublished = false;
      this.boundaryAt = null;
    }
    if (!voiced && this.silence === 0) this.boundaryAt = performance.now() - ms;
    this.silence = voiced ? 0 : this.silence + ms;
    if (this.silence >= 80 && !this.boundaryPublished) {
      this.boundaryPublished = true;
      this.boundary?.(this.boundaryAt);
    }
    if (voiced) this.quietEnergy = this.quietFrames = 0;
    else {
      this.quietEnergy += rms;
      ++this.quietFrames;
    }
    if (this.silence >= 600) this.finish();
  }
  finish() {
    if (this.speaking) {
      if (this.silence >= 600 && this.quietFrames)
        this.noiseFloor = this.quietEnergy / this.quietFrames;
      this.speaking = false;
      this.onset = 0;
      this.silence = 0;
      this.boundaryAt = null;
      this.boundaryPublished = false;
      this.end();
    }
    this.pre = [];
    this.preMs = 0;
  }
}
