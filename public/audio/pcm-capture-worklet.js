class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bytes = new ArrayBuffer(Math.round(sampleRate * 0.02) * 2);
    this.view = new DataView(this.bytes);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(
        this.offset,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
      this.offset += 2;
      if (this.offset === this.bytes.byteLength) {
        this.port.postMessage(this.bytes, [this.bytes]);
        this.bytes = new ArrayBuffer(Math.round(sampleRate * 0.02) * 2);
        this.view = new DataView(this.bytes);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
