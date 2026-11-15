import { test } from "node:test";
import assert from "node:assert/strict";
import { FFT_SIZE, HOP, SAMPLE_RATE, FeedbackDetector, ChannelAnalyzer, spectrumDb, rmsDb, binHz } from "../server/spectrum.ts";

/** Runs a generator through the detector in analysis hops; returns the first hit (freq) and when. */
function detect(gen: (t: number) => number, seconds: number, music = false): { freq: number; at: number } | null {
  const det = new FeedbackDetector();
  const buf = new Float64Array(FFT_SIZE);
  let n = 0;
  for (let hop = 0; hop * HOP < seconds * SAMPLE_RATE; hop++) {
    buf.copyWithin(0, HOP);
    for (let i = FFT_SIZE - HOP; i < FFT_SIZE; i++, n++) buf[i] = gen(n / SAMPLE_RATE);
    if (hop * HOP < FFT_SIZE) continue;
    const t = (n / SAMPLE_RATE) * 1000;
    const hit = det.push(spectrumDb(buf), t, music, rmsDb(buf));
    if (hit) return { freq: hit.freq, at: t };
  }
  return null;
}

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

/** A voice: harmonics of a pitch that keeps moving (intonation) + syllables + breath noise. */
const voice = (t: number) => {
  const f0 = 120 + 25 * Math.sin(2 * Math.PI * 0.7 * t) + 10 * Math.sin(2 * Math.PI * 3.1 * t);
  const phase = 2 * Math.PI * (120 * t - (25 / (2 * Math.PI * 0.7)) * Math.cos(2 * Math.PI * 0.7 * t) - (10 / (2 * Math.PI * 3.1)) * Math.cos(2 * Math.PI * 3.1 * t));
  const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * t));
  let s = 0;
  for (let h = 1; h <= 25; h++) s += Math.sin(h * phase) / h;
  return 0.15 * syll * s + 0.01 * rnd() + 0 * f0;
};

test("FFT: a 1 kHz sine at full scale peaks at 1 kHz near 0 dB", () => {
  const x = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
  const s = spectrumDb(x);
  let k = 0;
  for (let i = 1; i < s.length; i++) if (s[i] > s[k]) k = i;
  assert.ok(Math.abs(k * binHz - 1000) < binHz, `peak at ${k * binHz} Hz`);
  assert.ok(Math.abs(s[k]) < 1.5, `level ${s[k]}`);
});

test("feedback: a growing tone over speech is found within about a second, at the right frequency", () => {
  const hit = detect((t) => voice(t) + (t > 1 ? 0.002 * Math.pow(10, (t - 1) * 1.2) : 0) * Math.sin(2 * Math.PI * 2537 * t), 4);
  assert.ok(hit, "found");
  assert.ok(Math.abs(hit!.freq - 2537) < 6, `freq ${hit!.freq}`);
  assert.ok(hit!.at < 3500, `after ${hit!.at} ms`);
});

test("speech alone is never taken for feedback", () => {
  assert.equal(detect(voice, 20), null);
});

test("a sustained organ chord during music is not feedback – a growing tone during music is", () => {
  const chord = (t: number) => 0.2 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t));
  assert.equal(detect(chord, 6, true), null);
  const growing = detect((t) => chord(t) + 0.01 * Math.pow(10, t * 0.6) * Math.sin(2 * Math.PI * 1580 * t), 4, true);
  assert.ok(growing && Math.abs(growing.freq - 1580) < 6, `growing tone ${growing?.freq}`);
});

test("noise and applause are not feedback", () => {
  assert.equal(detect(() => 0.3 * rnd(), 6), null);
});

test("ChannelAnalyzer splits interleaved channels and reports per channel", () => {
  const a = new ChannelAnalyzer(2);
  const frames = SAMPLE_RATE * 2;
  const buf = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE), i * 8);
    buf.writeFloatLE(0, i * 8 + 4);
  }
  let t = 0;
  a.write(buf, () => (t += 85), () => false, () => {});
  assert.ok(Math.abs(a.peaks[0] - 440) < binHz, `ch1 peak ${a.peaks[0]}`);
  assert.ok(a.levels[0] > -10 && a.levels[1] < -100, `levels ${a.levels}`);
});

/** Voices of different pitch and speed for a longer robustness check. */
const voiceAt = (base: number, rate: number) => (t: number) => {
  const phase = 2 * Math.PI * (base * t - ((base * 0.2) / (2 * Math.PI * rate)) * Math.cos(2 * Math.PI * rate * t));
  const syll = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t + Math.sin(t)));
  let s = 0;
  for (let h = 1; h <= 20; h++) s += Math.sin(h * phase) / (h * (h > 3 ? 1.5 : 1));
  return 0.15 * syll * s + 0.01 * rnd();
};

test("long speech of a low and a high voice: no false alarm in a minute", () => {
  assert.equal(detect(voiceAt(105, 0.5), 60), null, "low voice");
  assert.equal(detect(voiceAt(215, 0.8), 60), null, "high voice");
});

test("low-frequency feedback (400 Hz) over a voice is found", () => {
  const hit = detect((t) => voiceAt(215, 0.8)(t) + (t > 1 ? 0.003 * Math.pow(10, (t - 1)) : 0) * Math.sin(2 * Math.PI * 403 * t), 4);
  assert.ok(hit && Math.abs(hit.freq - 403) < 6, `hit ${JSON.stringify(hit)}`);
});

test("a steady tone (unamplified organ flute, test tone) never counts as feedback", () => {
  assert.equal(detect((t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.01 * rnd(), 10), null);
});
