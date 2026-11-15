// Audio analysis for the Raum-Automatik (pure, testable): FFT, level and feedback detection.
//
// Feedback ("Pfeifen") is a single narrow tone that stands far above the rest of the spectrum,
// stays on the same frequency and does not fade. Speech moves in pitch all the time, so its
// harmonics never stay on one bin for long. Sustained notes do stay, but they do not keep
// growing – a peak must rise to count as feedback (more so during music).

export const SAMPLE_RATE = 48000;
export const FFT_SIZE = 8192;          // 170 ms window, 5.9 Hz per bin
export const HOP = 4096;               // ~11.7 analyses per second

/** In-place radix-2 FFT (re/im arrays, length = power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const HANN = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  return w;
})();

/** Magnitude spectrum in dBFS (sine at full scale ≈ 0 dB) of FFT_SIZE samples. */
export function spectrumDb(samples: Float32Array | Float64Array): Float64Array {
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) re[i] = (samples[i] ?? 0) * HANN[i];
  fft(re, im);
  const out = new Float64Array(FFT_SIZE / 2);
  for (let k = 0; k < out.length; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / (FFT_SIZE / 4) + 1e-12);
  return out;
}

/** RMS level in dBFS. */
export function rmsDb(samples: Float32Array | Float64Array, from = 0, to = samples.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += samples[i] * samples[i];
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-12);
}

export const binHz = SAMPLE_RATE / FFT_SIZE;
const MIN_HZ = 150;
const MAX_HZ = 10000;
/** A peak must stand this far above its surroundings … */
const PROMINENCE_DB = 15;
/** … be at least this loud … */
const MIN_LEVEL_DB = -70;
/** … and stay on the same frequency (± bins) this long. */
const TRACK_BINS = 2;
const PERSIST_MS = 600;
/** Share of frames since the start in which the peak must be present. */
const PRESENT_SHARE = 0.8;
/** Not fading: the last frame may be at most this far below the track's maximum. */
const FADE_DB = 4;
/**
 * Feedback builds up: the peak must have grown at least this much since it appeared. A steady
 * tone (an unamplified organ heard by the room mics, a test tone) never qualifies.
 */
const RISE_DB = 2;
/** During music (instrument channels active) it must have grown more. */
const MUSIC_RISE_DB = 4;
/**
 * The tone must carry a good part of the whole signal (feedback takes over; a single harmonic of
 * a voice or one note in a chord does not): peak level ≥ RMS level of the frame + this.
 * (A pure sine shows ≈ +3 dB here – its spectrum peak is full scale, its RMS −3 dB.)
 */
const DOMINANCE_DB = -3;
/** One report per frequency, then quiet – long enough to hear whether the notch helped. */
const REPORT_HOLD_MS = 3000;

export interface FeedbackHit { freq: number; level: number }

interface Track { bin: number; first: number; last: number; frames: number; seen: number; levels: number[] }

/** Finds feedback tones in a stream of spectra (one detector per audio channel). */
export class FeedbackDetector {
  private tracks: Track[] = [];
  private reported = new Map<number, number>();

  /** Feeds one spectrum (dB per bin); returns a hit when a tone qualifies as feedback. */
  push(spec: Float64Array, t: number, music = false, rms = -Infinity): FeedbackHit | null {
    const peaks = findPeaks(spec);
    for (const tr of this.tracks) tr.frames++;
    for (const p of peaks) {
      const tr = this.tracks.find((x) => Math.abs(x.bin - p.bin) <= TRACK_BINS);
      if (tr) { tr.bin = p.bin; tr.last = t; tr.seen++; tr.levels.push(p.level); if (tr.levels.length > 40) tr.levels.shift(); }
      else this.tracks.push({ bin: p.bin, first: t, last: t, frames: 1, seen: 1, levels: [p.level] });
    }
    // Drop tracks that disappeared.
    this.tracks = this.tracks.filter((tr) => t - tr.last <= 250);
    for (const [bin, at] of this.reported) if (t - at > REPORT_HOLD_MS) this.reported.delete(bin);

    let best: FeedbackHit | null = null;
    for (const tr of this.tracks) {
      if (t - tr.first < PERSIST_MS || tr.seen / tr.frames < PRESENT_SHARE) continue;
      const max = Math.max(...tr.levels), lastLevel = tr.levels[tr.levels.length - 1];
      if (lastLevel < max - FADE_DB) continue;
      if (lastLevel < rms + DOMINANCE_DB) continue;
      if (isHarmonic(spec, tr.bin, lastLevel)) continue;
      if (lastLevel - Math.min(...tr.levels) < (music ? MUSIC_RISE_DB : RISE_DB)) continue;
      if ([...this.reported.keys()].some((b) => Math.abs(b - tr.bin) <= TRACK_BINS * 2)) continue;
      if (!best || lastLevel > best.level) best = { freq: interpolatedFreq(spec, tr.bin), level: lastLevel };
    }
    if (best) this.reported.set(Math.round(best.freq / binHz), t);
    return best;
  }
}

/** Local maxima that stand PROMINENCE_DB above the mean of their ±1/6-octave surroundings. */
export function findPeaks(spec: Float64Array): { bin: number; level: number }[] {
  const out: { bin: number; level: number }[] = [];
  const lo = Math.ceil(MIN_HZ / binHz), hi = Math.min(spec.length - 2, Math.floor(MAX_HZ / binHz));
  for (let k = lo; k <= hi; k++) {
    const v = spec[k];
    if (v < MIN_LEVEL_DB || v < spec[k - 1] || v < spec[k + 1]) continue;
    const w = Math.max(6, Math.round(k * 0.06));
    let sum = 0, n = 0;
    for (let j = k - w; j <= k + w; j++) {
      if (j < 1 || j >= spec.length || Math.abs(j - k) <= 3) continue;
      sum += spec[j]; n++;
    }
    if (n && v - sum / n >= PROMINENCE_DB) out.push({ bin: k, level: v });
  }
  return out;
}

/**
 * A voice or an instrument comes with a series of overtones; feedback is a lone tone. The peak is
 * "harmonic" when ½, ⅓, 2× or 3× its frequency also holds a clear peak not far below it.
 */
function isHarmonic(spec: Float64Array, k: number, level: number): boolean {
  for (const r of [1 / 2, 1 / 3, 2, 3]) {
    const c = Math.round(k * r);
    if (c < 3 || c >= spec.length - 3) continue;
    let m = -Infinity, at = c;
    const tol = Math.max(2, Math.round(c * 0.02));
    for (let j = c - tol; j <= c + tol; j++) if (spec[j] > m) { m = spec[j]; at = j; }
    if (m < level - 20) continue;
    const w = Math.max(6, Math.round(at * 0.06));
    let sum = 0, n = 0;
    for (let j = at - w; j <= at + w; j++) if (j > 0 && j < spec.length && Math.abs(j - at) > 3) { sum += spec[j]; n++; }
    if (n && m - sum / n >= PROMINENCE_DB - 5) return true;
  }
  return false;
}

/** Parabolic interpolation around a peak bin → frequency in Hz. */
function interpolatedFreq(spec: Float64Array, k: number): number {
  const a = spec[k - 1], b = spec[k], c = spec[k + 1];
  const d = a - 2 * b + c;
  const off = d === 0 ? 0 : (0.5 * (a - c)) / d;
  return (k + Math.max(-0.5, Math.min(0.5, off))) * binHz;
}

/** Splits a stream of interleaved float32 samples into channels and analyses each one. */
export class ChannelAnalyzer {
  private buf: Float32Array[] = [];
  private fill = 0;
  readonly detectors: FeedbackDetector[] = [];
  /** last RMS level and strongest frequency per channel (for the display and channel matching) */
  levels: number[] = [];
  peaks: number[] = [];
  private pending: Buffer = Buffer.alloc(0);
  readonly channels: number;

  constructor(channels: number) {
    this.channels = channels;
    for (let c = 0; c < channels; c++) { this.buf.push(new Float32Array(FFT_SIZE)); this.detectors.push(new FeedbackDetector()); }
  }

  /** Feeds raw f32le bytes. Calls `onFrame` for every analysis hop. */
  write(chunk: Buffer, t: () => number, music: () => boolean, onFrame: (ch: number, level: number, hit: FeedbackHit | null) => void): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frameBytes = 4 * this.channels;
    const frames = Math.floor(this.pending.length / frameBytes);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) this.buf[c][this.fill] = this.pending.readFloatLE(i * frameBytes + c * 4);
      this.fill++;
      if (this.fill === FFT_SIZE) {
        for (let c = 0; c < this.channels; c++) {
          const level = rmsDb(this.buf[c], FFT_SIZE - HOP, FFT_SIZE);
          const spec = spectrumDb(this.buf[c]);
          let strongest = 0;
          for (let k = 1; k < spec.length; k++) if (spec[k] > spec[strongest]) strongest = k;
          this.levels[c] = level;
          this.peaks[c] = strongest * binHz;
          const hit = level > -75 ? this.detectors[c].push(spec, t(), music(), rmsDb(this.buf[c])) : null;
          onFrame(c, level, hit);
          this.buf[c].copyWithin(0, HOP);
        }
        this.fill = FFT_SIZE - HOP;
      }
    }
    this.pending = this.pending.subarray(frames * frameBytes);
  }
}
