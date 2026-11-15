// EQ notches against feedback (pure, testable): which band to use, how deep, how to undo.
//
// Only a "free" band is used – a bell band whose gain is 0 dB – so the technician's own EQ is
// never changed. The band's previous settings are kept to restore them ("Kerben entfernen").

import type { EqBand, EqSettings } from "../shared/rcp.ts";

export const NOTCH_Q = 8;
export const NOTCH_START_DB = -6;
export const NOTCH_STEP_DB = -3;
export const NOTCH_MAX_DB = -12;
/** Feedback within this many octaves of an existing notch deepens it instead of using a new band. */
const SAME_OCTAVES = 1 / 6;

export interface Notch {
  band: number;
  freq: number;
  gain: number;
  /** the band before the notch – restored by "Kerben entfernen" */
  orig: EqBand;
}

export type NotchPlan =
  | { ok: true; band: number; value: EqBand; notch: Notch; deepened: boolean }
  | { ok: false; reason: string };

/** Bands that are bells (not shelf / low-pass). */
function isBell(eq: EqSettings, band: number): boolean {
  if (band === 0) return !eq.lowShelf;
  if (band === 3) return !eq.highShelf && !eq.highLpf;
  return true;
}

export function planNotch(eq: EqSettings, existing: Notch[], freq: number): NotchPlan {
  if (!eq.on) return { ok: false, reason: "EQ des Kanals ist aus" };
  const near = existing.find((n) => Math.abs(Math.log2(freq / n.freq)) <= SAME_OCTAVES);
  if (near) {
    if (near.gain <= NOTCH_MAX_DB) return { ok: false, reason: `Kerbe bei ${hzText(near.freq)} ist schon am tiefsten` };
    const gain = Math.max(NOTCH_MAX_DB, near.gain + NOTCH_STEP_DB);
    const value = { freq: near.freq, gain, q: NOTCH_Q };
    return { ok: true, band: near.band, value, notch: { ...near, gain }, deepened: true };
  }
  const used = new Set(existing.map((n) => n.band));
  const free = [0, 1, 2, 3].filter((b) => !used.has(b) && isBell(eq, b) && Math.abs(eq.bands[b].gain) < 0.05);
  if (!free.length) return { ok: false, reason: "kein freies EQ-Band" };
  // The free band closest in frequency – the curve changes least where it is visible.
  const band = free.sort((a, b) => Math.abs(Math.log2(eq.bands[a].freq / freq)) - Math.abs(Math.log2(eq.bands[b].freq / freq)))[0];
  const value = { freq, gain: NOTCH_START_DB, q: NOTCH_Q };
  return { ok: true, band, value, notch: { band, freq, gain: NOTCH_START_DB, orig: { ...eq.bands[band] } }, deepened: false };
}

export const hzText = (f: number) => (f >= 1000 ? `${(Math.round(f / 100) / 10).toString().replace(".", ",")} kHz` : `${Math.round(f)} Hz`);
