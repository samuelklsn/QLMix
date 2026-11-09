// Measures the speech level in the room with the device microphone (Web Audio).
// Requires a secure context (HTTPS) – browsers block microphone access on plain http.

export interface RoomSample {
  /** speech-band level in dBFS (200 Hz – 4 kHz), uncalibrated */
  level: number;
  /** narrow, persistent peak typical for acoustic feedback */
  feedback: boolean;
}

const FRAME_MS = 100;

export class RoomMeter {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setInterval>;
  private wakeLock?: { release(): Promise<void> } | null;
  private peakHistory: { bin: number; excess: number }[] = [];

  static get supported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(onSample: (s: RoomSample) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.resume();
    const src = ctx.createMediaStreamSource(this.stream);

    // Speech band for the level …
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 200;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4000;
    const level = ctx.createAnalyser();
    level.fftSize = 2048;
    src.connect(hp).connect(lp).connect(level);

    // … and the full spectrum for feedback detection.
    const spectrum = ctx.createAnalyser();
    spectrum.fftSize = 4096;
    spectrum.smoothingTimeConstant = 0.3;
    src.connect(spectrum);

    const time = new Float32Array(level.fftSize);
    const freq = new Float32Array(spectrum.frequencyBinCount);
    const binHz = ctx.sampleRate / spectrum.fftSize;
    let frames: number[] = [];
    let fb = false;

    this.timer = setInterval(() => {
      level.getFloatTimeDomainData(time);
      let sum = 0;
      for (const x of time) sum += x * x;
      frames.push(10 * Math.log10(Math.max(sum / time.length, 1e-12)));

      spectrum.getFloatFrequencyData(freq);
      fb = fb || this.detectFeedback(freq, binHz);

      if (frames.length >= 2) {
        const avg = 10 * Math.log10(frames.reduce((a, d) => a + Math.pow(10, d / 10), 0) / frames.length);
        onSample({ level: Math.round(avg * 10) / 10, feedback: fb });
        frames = [];
        fb = false;
      }
    }, FRAME_MS);

    try {
      this.wakeLock = await (navigator as any).wakeLock?.request("screen");
    } catch {
      this.wakeLock = null;
    }
  }

  /** A single bin ≥ 30 dB above the band median, loud, stable for ≥ 4 frames (~0.4 s). */
  private detectFeedback(freq: Float32Array, binHz: number): boolean {
    const lo = Math.floor(250 / binHz), hi = Math.min(freq.length - 1, Math.floor(8000 / binHz));
    let peakBin = lo, peak = -Infinity;
    const band: number[] = [];
    for (let i = lo; i <= hi; i++) {
      band.push(freq[i]);
      if (freq[i] > peak) { peak = freq[i]; peakBin = i; }
    }
    band.sort((a, b) => a - b);
    const median = band[Math.floor(band.length / 2)];
    const excess = peak - median;
    this.peakHistory.push({ bin: peakBin, excess: peak > -45 ? excess : 0 });
    if (this.peakHistory.length > 4) this.peakHistory.shift();
    return this.peakHistory.length === 4 && this.peakHistory.every((p) => p.excess > 30 && Math.abs(p.bin - peakBin) <= 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.peakHistory = [];
  }
}
