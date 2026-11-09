// Raum-Automatik: keeps the speech level at the listening position constant.
//
// Inputs:  room level measured by a phone in the room (dBFS, speech band, ~5 values/s),
//          optional feedback flag from the phone, console input meters (who is talking).
// Output:  small, rate-limited fader moves on the active speech microphone.
//
// Safety: only selected channels, bounded around the fader position at start (maxBoost/maxCut,
// absolute ceiling), manual fader moves pause the channel, feedback → immediate cut,
// missing measurement → hold.

import type { ChannelId } from "../shared/rcp.ts";

export interface AutoConfig {
  channels: ChannelId[];
  /** Reference room level (dBFS on the measuring phone) – set with "So soll es klingen". */
  reference: number | null;
  /** User offset in dB (louder / quieter than the reference). */
  offset: number;
  maxBoost: number;   // dB above the starting fader position
  maxCut: number;     // dB below the starting fader position
  speed: number;      // dB per second
  ceiling: number;    // absolute fader ceiling in dB
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  channels: [], reference: null, offset: 0, maxBoost: 6, maxCut: 10, speed: 1, ceiling: 5,
};

export interface AutoIO {
  now(): number;
  /** fader level in 0.01 dB (−32768 = −∞), undefined if unknown */
  fader(c: ChannelId): number | undefined;
  isOn(c: ChannelId): boolean;
  setFader(c: ChannelId, raw: number): void;
  label(c: ChannelId): string;
}

export interface AutoStatus {
  enabled: boolean;
  message: string;
  level: "ok" | "info" | "warn";
  active: string | null;
  activeKey: string | null;
  room: { level: number | null; speech: number | null; floor: number | null; target: number | null; fresh: boolean };
  metersAvailable: boolean;
  corrections: Record<string, number>; // channel key → dB relative to start
  feedback: boolean;
}

const ck = (c: ChannelId) => `${c.kind}:${c.index}`;
const NEG_INF = -32768;
const DEADBAND = 1.5;
const ROOM_STALE_MS = 2000;
const SPEECH_WINDOW_MS = 2500;
const FLOOR_WINDOW_MS = 20000;
const FEEDBACK_CUT_DB = 3;
const FEEDBACK_PAUSE_MS = 10000;
const MANUAL_PAUSE_MS = 20000;
const WRITE_INTERVAL_MS = 200;

interface RoomSample { t: number; level: number; feedback: boolean }
interface ChannelState { baseline: number; lastWritten: number | null; pausedUntil: number; lastWriteAt: number; noRaiseUntil: number }

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
}

function powerMean(dbs: number[]): number {
  return 10 * Math.log10(dbs.reduce((a, d) => a + Math.pow(10, d / 10), 0) / dbs.length);
}

export class AutoLevel {
  config: AutoConfig;
  enabled = false;

  private room: RoomSample[] = [];
  private meters: { t: number; levels: Map<string, number> } | null = null;
  private meterHistory = new Map<string, { t: number; v: number }[]>();
  private channels = new Map<string, ChannelState>();
  private status: AutoStatus;
  private lastTick = 0;

  private io: AutoIO;

  constructor(io: AutoIO, config: Partial<AutoConfig> = {}) {
    this.io = io;
    this.config = { ...DEFAULT_AUTO_CONFIG, ...config };
    this.status = this.emptyStatus("Aus");
  }

  // ------------------------------------------------------------ inputs

  addRoomSample(level: number, feedback: boolean): void {
    if (!Number.isFinite(level)) return;
    const t = this.io.now();
    this.room.push({ t, level: Math.max(-120, Math.min(0, level)), feedback });
    const cutoff = t - FLOOR_WINDOW_MS;
    while (this.room.length && this.room[0].t < cutoff) this.room.shift();
  }

  /** Console input meters: channel key → raw meter value (0…126). */
  setMeters(levels: Map<string, number>): void {
    const t = this.io.now();
    this.meters = { t, levels };
    for (const c of this.config.channels) {
      const v = levels.get(ck(c));
      if (v === undefined) continue;
      const h = this.meterHistory.get(ck(c)) ?? [];
      h.push({ t, v });
      while (h.length && h[0].t < t - FLOOR_WINDOW_MS) h.shift();
      this.meterHistory.set(ck(c), h);
    }
  }

  // ------------------------------------------------------------ control

  start(): string | null {
    if (this.config.channels.length === 0) return "Bitte zuerst Sprecher-Mikrofone auswählen.";
    if (this.config.reference === null) return "Bitte zuerst „So soll es klingen“ festlegen.";
    this.enabled = true;
    this.channels.clear(); // baselines are taken from the current fader positions
    return null;
  }

  stop(): void {
    this.enabled = false;
    this.status = { ...this.status, enabled: false, message: "Aus", level: "info" };
  }

  /** Uses the current speech level as the target ("So soll es klingen"). */
  takeReference(): string | null {
    const speech = this.speechLevel();
    if (speech === null) return "Gerade wird nicht gesprochen – bitte während einer normalen Rede drücken.";
    this.config.reference = Math.round(speech * 10) / 10;
    this.config.offset = 0;
    return null;
  }

  getStatus(): AutoStatus {
    return this.status;
  }

  /** Called periodically (e.g. every 250 ms). */
  tick(): void {
    const now = this.io.now();
    const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 1) : 0.25;
    this.lastTick = now;

    const fresh = this.room.length > 0 && now - this.room[this.room.length - 1].t < ROOM_STALE_MS;
    const floor = this.room.length >= 10 ? percentile(this.room.map((s) => s.level), 0.1) : null;
    const speech = this.speechLevel();
    const target = this.config.reference === null ? null : this.config.reference + this.config.offset;
    const metersAvailable = !!this.meters && now - this.meters.t < 1500;
    const feedback = this.room.some((s) => s.feedback && now - s.t < 600);
    const base = {
      enabled: this.enabled,
      room: { level: fresh ? this.room[this.room.length - 1].level : null, speech, floor, target, fresh },
      metersAvailable,
      corrections: this.corrections(),
      feedback,
    };
    const set = (message: string, level: AutoStatus["level"], active: ChannelId | null = null) => {
      this.status = { ...base, message, level, active: active ? this.io.label(active) : null, activeKey: active ? ck(active) : null, corrections: this.corrections() };
    };

    if (!this.enabled) return set("Aus", "info");
    if (!fresh) return set("Keine Messung vom Handy – Fader bleiben stehen.", "warn");

    // Detect manual moves on all controlled channels.
    for (const c of this.config.channels) {
      const st = this.channels.get(ck(c));
      const f = this.io.fader(c);
      if (!st || f === undefined || st.lastWritten === null) continue;
      if (Math.abs(f - st.lastWritten) > 30) {
        st.baseline = f;
        st.lastWritten = null;
        st.pausedUntil = now + MANUAL_PAUSE_MS;
      }
    }

    const active = this.activeChannel(metersAvailable);
    if (feedback) {
      const victims = active ? [active] : this.config.channels.filter((c) => this.io.isOn(c));
      for (const c of victims) {
        const st = this.state(c);
        if (!st) continue;
        this.move(c, st, -FEEDBACK_CUT_DB * 100, true);
        st.noRaiseUntil = now + FEEDBACK_PAUSE_MS;
      }
      return set("Rückkopplung erkannt – Pegel reduziert.", "warn", active);
    }
    if (!active) {
      const open = this.config.channels.filter((c) => this.io.isOn(c) && (this.io.fader(c) ?? NEG_INF) > -6000);
      if (open.length === 0) return set("Kein Sprecher-Mikrofon offen.", "info");
      return set(metersAvailable ? "Kein Mikrofon spricht gerade." : "Mehrere Mikrofone offen – ohne Pult-Pegel nicht eindeutig.", "info");
    }
    const st = this.state(active)!;
    if (st.pausedUntil > now) return set(`${this.io.label(active)}: von Hand verstellt – Automatik pausiert kurz.`, "info", active);
    if (speech === null || target === null) return set(`${this.io.label(active)}: warte auf Sprache …`, "info", active);

    const error = target - speech;
    if (Math.abs(error) < DEADBAND) return set(`${this.io.label(active)}: Lautstärke passt.`, "ok", active);
    if (error > 0 && st.noRaiseUntil > now) return set(`${this.io.label(active)}: nach Rückkopplung kein Anheben.`, "warn", active);
    if (now - st.lastWriteAt < WRITE_INTERVAL_MS) return set(this.status.message, this.status.level, active);

    const stepDb = Math.sign(error) * Math.min(Math.abs(error) * 0.5, this.config.speed * Math.max(dt, (now - st.lastWriteAt) / 1000));
    const limited = this.move(active, st, Math.round(stepDb * 100), false);
    if (limited) return set(`${this.io.label(active)}: Grenze erreicht (${error > 0 ? "max. Anhebung" : "max. Absenkung"}).`, "warn", active);
    return set(`${this.io.label(active)}: ${error > 0 ? "zu leise – ziehe hoch" : "zu laut – nehme zurück"} (${error > 0 ? "+" : ""}${error.toFixed(1)} dB)`, "ok", active);
  }

  // ------------------------------------------------------------ internals

  private emptyStatus(message: string): AutoStatus {
    return {
      enabled: false, message, level: "info", active: null, activeKey: null,
      room: { level: null, speech: null, floor: null, target: null, fresh: false },
      metersAvailable: false, corrections: {}, feedback: false,
    };
  }

  /** Mean speech level over the last seconds, ignoring pauses (samples near the noise floor). */
  private speechLevel(): number | null {
    if (this.room.length < 10) return null;
    const now = this.io.now();
    const floor = percentile(this.room.map((s) => s.level), 0.1);
    const recent = this.room.filter((s) => now - s.t < SPEECH_WINDOW_MS && s.level > floor + 6);
    if (recent.length < 4) return null;
    return powerMean(recent.map((s) => s.level));
  }

  private activeChannel(metersAvailable: boolean): ChannelId | null {
    const candidates = this.config.channels.filter((c) => this.io.isOn(c) && (this.io.fader(c) ?? NEG_INF) > -6000);
    if (!metersAvailable) return candidates.length === 1 ? candidates[0] : null;
    let best: ChannelId | null = null;
    let bestLevel = -Infinity;
    for (const c of candidates) {
      const h = this.meterHistory.get(ck(c));
      const v = this.meters!.levels.get(ck(c));
      if (!h || v === undefined || h.length < 5) continue;
      const floor = percentile(h.map((x) => x.v), 0.1);
      if (v > floor + 10 && v > bestLevel) { best = c; bestLevel = v; }
    }
    return best;
  }

  private state(c: ChannelId): ChannelState | null {
    let st = this.channels.get(ck(c));
    if (!st) {
      const f = this.io.fader(c);
      if (f === undefined || f <= NEG_INF) return null;
      st = { baseline: f, lastWritten: null, pausedUntil: 0, lastWriteAt: 0, noRaiseUntil: 0 };
      this.channels.set(ck(c), st);
    }
    return st;
  }

  /** Moves a fader by `deltaRaw` (0.01 dB) within the limits. Returns true if a limit was hit. */
  private move(c: ChannelId, st: ChannelState, deltaRaw: number, force: boolean): boolean {
    const f = this.io.fader(c);
    if (f === undefined || f <= NEG_INF) return false;
    const lo = st.baseline - this.config.maxCut * 100;
    const hi = Math.min(st.baseline + this.config.maxBoost * 100, this.config.ceiling * 100);
    let next = Math.round((f + deltaRaw) / 10) * 10;
    let limited = false;
    // Never push a fader back across a limit it already exceeds (e.g. set higher by hand before).
    if (next > hi) { next = f > hi ? f : hi; limited = true; }
    if (next < lo) { next = f < lo ? f : lo; limited = true; }
    if (next === f && !force) return limited;
    this.io.setFader(c, next);
    st.lastWritten = next;
    st.lastWriteAt = this.io.now();
    return limited;
  }

  private corrections(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.config.channels) {
      const st = this.channels.get(ck(c));
      const f = this.io.fader(c);
      if (st && f !== undefined && f > NEG_INF) out[ck(c)] = Math.round((f - st.baseline) / 10) / 10;
    }
    return out;
  }
}

// ---------------------------------------------------------------- console meters

/**
 * Decodes the CL/QL input meter block (editor protocol, F0 43 1n 3E 19 21 00 7F 00 … F7):
 * 88 records (72 mono + 16 stereo halves, CL5 layout) × 10 metering points, raw 0…126.
 * Point 1 (pre-EQ) is used for "who is talking". Stereo inputs start at record 72.
 */
export function decodeInputMeters(m: Uint8Array): Map<string, number> | null {
  if (m.length < 10 || m[5] !== 0x21 || m[6] !== 0x00) return null;
  const data = m.subarray(9, m.length - 1);
  if (data.length < 880) return null;
  const out = new Map<string, number>();
  const rec = (i: number, point: number) => data[i * 10 + point];
  for (let i = 0; i < 72; i++) out.set(`input:${i}`, rec(i, 1));
  for (let s = 0; s < 8; s++) out.set(`stereoInput:${s}`, Math.max(rec(72 + 2 * s, 1), rec(73 + 2 * s, 1)));
  return out;
}

/** Request for the input meter stream (re-sent every few seconds, like QL Editor). */
export const INPUT_METER_REQUEST = [0xf0, 0x43, 0x30, 0x3e, 0x19, 0x21, 0x00, 0x7f, 0x00, 0x00, 0x58, 0xf7];
