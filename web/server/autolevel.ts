// Raum-Automatik: one target speech level in the room for every speaker microphone.
//
// Inputs:  console input meters (pre-EQ, i.e. before ON and fader) of
//          - the speaker mics: who is talking (works while a channel is switched off),
//          - one or more room mics hanging in the room: how loud it is in the room
//            (their channels may be off / faders down – the meter is taken before them).
// Output:  - a mic that somebody clearly talks into is switched ON and its fader jumps to the
//            position that last gave the target level ("learned", per mic) or the start level,
//          - small, rate-limited fader moves on the active mic until the room hits the target,
//          - any selected mic nobody talked into for `closeAfter` seconds: fader down to −∞,
//          - feedback (steady tone at room mic AND speaker mic): cut 6 dB, remember a per-mic limit.
//
// Safety: only selected channels, fader range [minLevel, ceiling], opening needs clear and
// dominant speech for a moment, manual fader/ON changes win (pause, or "stay closed"),
// feedback → immediate cut, per-mic limit and no raising/opening for a while,
// missing room meters → no fine regulation.

import { type ChannelId, levelToPosition } from "../shared/rcp.ts";

export interface AutoConfig {
  /** speaker mics the automatic may switch on and move */
  channels: ChannelId[];
  /** room mics that measure the level in the room (never moved) */
  roomMics: ChannelId[];
  /** Reference room level (dBFS at the room mics) – set with "So soll es klingen". */
  reference: number | null;
  /** User offset in dB (louder / quieter than the reference). */
  offset: number;
  speed: number;       // dB per second
  ceiling: number;     // fader never above (dB)
  minLevel: number;    // fader never below while regulating (dB); below counts as "closed"
  startLevel: number;  // opening position (dB) for a mic without a learned position
  closeAfter: number;  // seconds without speech before a mic's fader goes down to −∞
  /** channel key → fader position (0.01 dB) that gave the target level last time */
  learned: Record<string, number>;
  /** channel key → highest fader position (0.01 dB) allowed – 3 dB below where it fed back */
  limits: Record<string, number>;
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  channels: [], roomMics: [], reference: null, offset: 0, speed: 1, ceiling: 5, minLevel: -20, startLevel: -10, closeAfter: 30, learned: {}, limits: {},
};

export interface AutoIO {
  now(): number;
  /** fader level in 0.01 dB (−32768 = −∞), undefined if unknown */
  fader(c: ChannelId): number | undefined;
  isOn(c: ChannelId): boolean;
  setFader(c: ChannelId, raw: number): void;
  setOn(c: ChannelId, on: boolean): void;
  label(c: ChannelId): string;
}

export interface AutoStatus {
  enabled: boolean;
  message: string;
  level: "ok" | "info" | "warn";
  /** last opening/closing action, shown for a few seconds */
  event: string | null;
  active: string | null;
  activeKey: string | null;
  room: { level: number | null; speech: number | null; floor: number | null; target: number | null; fresh: boolean };
  metersAvailable: boolean;
  feedback: boolean;
  /** Per selected channel: what the detection sees (for the live display). */
  mics: MicInfo[];
}

export interface MicInfo {
  key: string;
  label: string;
  /** current console meter (raw 0…126 = dB + 126), null without meters */
  level: number | null;
  /** noise floor of this mic (raw) */
  floor: number | null;
  /** level above the mic's own noise floor (dB) */
  excess: number | null;
  speaking: boolean;
  on: boolean;
  /** ON and fader at or above the minimum */
  open: boolean;
  /** fader in dB, null = −∞/unknown */
  fader: number | null;
  /** switched off by hand while talking – stays closed until it was quiet for a while */
  blocked: boolean;
  /** learned fader position in dB */
  learned: number | null;
  /** feedback limit in dB */
  limit: number | null;
  /** seconds until the fader goes down (open mic, nobody talking) */
  closesIn: number | null;
}

const ck = (c: ChannelId) => `${c.kind}:${c.index}`;
const NEG_INF = -32768;
const DEADBAND = 1.5;
const ROOM_STALE_MS = 2000;
const SPEECH_WINDOW_MS = 2500;
const FLOOR_WINDOW_MS = 20000;
/** Mic noise floor: lowest 5 % of a minute – survives long speeches with only short pauses. */
const MIC_FLOOR_WINDOW_MS = 60000;
const MIC_FLOOR_PERCENTILE = 0.05;
const METER_STALE_MS = 1500;
/**
 * Feedback: speech always has small pauses, a feedback tone does not. When the room mics AND a
 * speaker mic stay within STEADY_DB for FEEDBACK_WINDOW_MS (room above the target), it is feedback.
 * Applause or music move the room mics but not a speaker mic's own close-up level in the same way.
 */
const FEEDBACK_WINDOW_MS = 1000;
const STEADY_DB = 6;
const FEEDBACK_CUT_DB = 6;
/** The limit is set this far below the position that fed back. */
const LIMIT_MARGIN_DB = 3;
const FEEDBACK_PAUSE_MS = 10000;
const FEEDBACK_COOLDOWN_MS = 1500;
const MANUAL_PAUSE_MS = 5000;
const WRITE_INTERVAL_MS = 200;
const EVENT_MS = 6000;
/** Short peak hold on the console meter so the gaps between words don't count as silence. */
const HOLD_MS = 400;
/** A mic counts as "speaking" when it is this many dB above its own noise floor. */
export const SPEAK_EXCESS = 8;
/** Opening a closed mic needs clearer speech … */
export const OPEN_EXCESS = 12;
/** … this much above every other selected mic (so a mic that only overhears stays closed) … */
export const DOMINANCE = 6;
/** … for at least this long. */
export const CONFIRM_MS = 250;
/** A mic switched off by hand may be reopened after this long without speech into it. */
export const UNBLOCK_MS = 10000;

interface RoomSample { t: number; level: number }
interface ChannelState {
  /** fader/ON as last seen or written by us – anything else is a manual change */
  seenFader: number | null;
  seenOn: boolean | null;
  lastWriteAt: number;
  pausedUntil: number;
  noRaiseUntil: number;
  lastFeedbackAt: number;
  blockedAt: number | null;
  speakingSince: number | null;
  /** last time this mic was the loudest speaking mic */
  lastActiveAt: number;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
}

function powerMean(dbs: number[]): number {
  return 10 * Math.log10(dbs.reduce((a, d) => a + Math.pow(10, d / 10), 0) / dbs.length);
}

/** Fader values differ by more than console rounding (0.5 dB and ~1 % of the travel). */
function faderDiffers(a: number, b: number): boolean {
  return Math.abs(a - b) > 50 && Math.abs(levelToPosition(a) - levelToPosition(b)) > 0.012;
}

const dbText = (raw: number) => (raw <= NEG_INF ? "−∞" : `${raw > 0 ? "+" : raw < 0 ? "−" : ""}${Math.abs(Math.round(raw / 10) / 10)} dB`);

export class AutoLevel {
  config: AutoConfig;
  enabled = false;

  private room: RoomSample[] = [];
  private meters: { t: number; levels: Map<string, number> } | null = null;
  private meterHistory = new Map<string, { t: number; v: number }[]>();
  private channels = new Map<string, ChannelState>();
  private status: AutoStatus;
  private lastTick = 0;
  private lastActiveKey: string | null = null;
  private bestKey: string | null = null;
  private noOpenUntil = 0;
  private event: { text: string; until: number } | null = null;
  /** Optional hook (server log) when the detected speaker changes. */
  onActiveChange?: (label: string | null) => void;
  /** Optional hook when the automatic opens or closes a mic (server log). */
  onEvent?: (text: string) => void;
  /** Called when the config changed by itself (learned positions) and should be saved. */
  onConfigChange?: () => void;

  private io: AutoIO;

  constructor(io: AutoIO, config: Partial<AutoConfig> = {}) {
    this.io = io;
    const { channels, roomMics, reference, offset, speed, ceiling, minLevel, startLevel, closeAfter, learned, limits } = { ...DEFAULT_AUTO_CONFIG, ...config };
    // Only known fields – drops settings of older versions (maxBoost/maxCut).
    this.config = { channels, roomMics, reference, offset, speed, ceiling, minLevel, startLevel, closeAfter, learned: { ...learned }, limits: { ...limits } };
    this.status = this.emptyStatus("Aus");
  }

  // ------------------------------------------------------------ inputs

  /** Console input meters: channel key → raw meter value (0…126 = dBFS + 126). */
  setMeters(levels: Map<string, number>): void {
    const t = this.io.now();
    this.meters = { t, levels };
    // Room level: power mean of the room mics in dBFS.
    const room = this.config.roomMics.map((c) => levels.get(ck(c))).filter((v): v is number => v !== undefined);
    if (room.length) {
      this.room.push({ t, level: Math.max(-126, Math.min(0, powerMean(room.map((v) => v - 126)))) });
      while (this.room.length && this.room[0].t < t - FLOOR_WINDOW_MS) this.room.shift();
    }
    for (const c of this.config.channels) {
      const v = levels.get(ck(c));
      if (v === undefined) continue;
      const h = this.meterHistory.get(ck(c)) ?? [];
      h.push({ t, v });
      while (h.length && h[0].t < t - MIC_FLOOR_WINDOW_MS) h.shift();
      this.meterHistory.set(ck(c), h);
    }
  }

  // ------------------------------------------------------------ control

  start(): string | null {
    if (this.config.roomMics.length === 0) return "Bitte zuerst die Raum-Mikrofone auswählen.";
    if (this.config.channels.length === 0) return "Bitte zuerst Sprecher-Mikrofone auswählen.";
    if (this.config.reference === null) return "Bitte zuerst „So soll es klingen“ festlegen.";
    this.enabled = true;
    this.channels.clear();
    this.bestKey = null;
    return null;
  }

  stop(): void {
    this.enabled = false;
    this.status = { ...this.status, enabled: false, message: "Aus", level: "info", event: null };
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
    const metersAvailable = !!this.meters && now - this.meters.t < METER_STALE_MS;
    const victims = this.enabled && metersAvailable && fresh ? this.feedbackVictims(now, target) : [];
    const feedback = victims.length > 0;
    const roomStatus = { level: fresh ? this.room[this.room.length - 1].level : null, speech, floor, target, fresh };

    const set = (message: string, level: AutoStatus["level"], active: ChannelId | null = null) => {
      if (this.event && this.event.until < now) this.event = null;
      this.status = {
        enabled: this.enabled, room: roomStatus, metersAvailable, feedback, mics: this.micInfo(metersAvailable),
        message, level, event: this.event?.text ?? null,
        active: active ? this.io.label(active) : null, activeKey: active ? ck(active) : null,
      };
      if (this.status.activeKey !== this.lastActiveKey) {
        this.lastActiveKey = this.status.activeKey;
        this.onActiveChange?.(this.status.active);
      }
    };

    if (!this.enabled) return set("Aus", "info");
    // Everything – who talks and how loud the room is – comes from the console meters.
    if (!metersAvailable) {
      this.bestKey = null;
      return set("Keine Pegel vom Pult – Automatik wartet. Läuft der QL Editor auf demselben PC wie QLMix?", "warn");
    }

    this.detectManualChanges(now);
    const best = this.detectSpeaker(now);
    this.closeSilentMics(now);

    // Feedback first: cut, remember a limit, and neither raise nor open anything for a while.
    if (feedback) {
      const names: string[] = [];
      for (const c of victims) {
        const st = this.state(c);
        const f = this.io.fader(c);
        if (f === undefined || f <= NEG_INF) continue;
        this.setLimit(c, f - LIMIT_MARGIN_DB * 100);
        this.move(c, st, -FEEDBACK_CUT_DB * 100, true);
        st.noRaiseUntil = now + FEEDBACK_PAUSE_MS;
        st.lastFeedbackAt = now;
        names.push(`${this.io.label(c)} (Grenze ${dbText(this.config.limits[ck(c)])})`);
      }
      this.noOpenUntil = now + FEEDBACK_PAUSE_MS;
      this.note(`Pfeifen erkannt: ${names.join(", ")} – 6 dB zurück, Grenze gemerkt.`);
      return set("Pfeifen erkannt – Pegel reduziert.", "warn", best);
    }

    if (best && !this.isOpen(best)) {
      const why = this.tryOpen(best, now);
      if (why) return set(why, "info", best);
    }

    if (!best) {
      return set(fresh ? "Kein Mikrofon spricht gerade." : "Bereit – aber von den Raum-Mikros kommt kein Pegel. Ohne sie wird nur geöffnet, nicht nachgeregelt.", "warn");
    }

    const st = this.state(best);
    const name = this.io.label(best);
    if (!fresh) return set(`${name} spricht – kein Pegel von den Raum-Mikros, Fader bleibt stehen.`, "warn", best);
    if (st.pausedUntil > now) return set(`${name}: von Hand verstellt – Automatik pausiert kurz.`, "info", best);
    if (speech === null || target === null) return set(`${name}: warte auf Sprache …`, "info", best);

    const error = target - speech;
    const f = this.io.fader(best);
    if (Math.abs(error) < DEADBAND) {
      if (f !== undefined) this.learn(best, f);
      return set(`${name}: Lautstärke passt.`, "ok", best);
    }
    if (error > 0 && st.noRaiseUntil > now) return set(`${name}: nach Rückkopplung kein Anheben.`, "warn", best);
    if (now - st.lastWriteAt < WRITE_INTERVAL_MS) return set(this.status.message, this.status.level, best);

    // At most `speed` dB per second – also after a pause (no sudden jumps when speech resumes).
    const stepDb = Math.sign(error) * Math.min(Math.abs(error) * 0.5, this.config.speed * Math.min(1, Math.max(dt, (now - st.lastWriteAt) / 1000)));
    const limited = this.move(best, st, Math.round(stepDb * 100), false);
    if (limited) {
      const lim = this.config.limits[ck(best)];
      const why = error < 0 ? `Fader nie unter ${dbText(this.config.minLevel * 100)}`
        : lim !== undefined && lim < this.config.ceiling * 100 ? `Pfeifgrenze ${dbText(lim)}` : `Fader nie über ${dbText(this.config.ceiling * 100)}`;
      return set(`${name}: Grenze erreicht (${why}).`, "warn", best);
    }
    return set(`${name}: ${error > 0 ? "zu leise – ziehe hoch" : "zu laut – nehme zurück"} (${error > 0 ? "+" : ""}${error.toFixed(1)} dB)`, "ok", best);
  }

  // ------------------------------------------------------------ internals

  private emptyStatus(message: string): AutoStatus {
    return {
      enabled: false, message, level: "info", event: null, active: null, activeKey: null,
      room: { level: null, speech: null, floor: null, target: null, fresh: false },
      metersAvailable: false, feedback: false, mics: [],
    };
  }

  private note(text: string): void {
    this.event = { text, until: this.io.now() + EVENT_MS };
    this.onEvent?.(text);
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

  private state(c: ChannelId): ChannelState {
    let st = this.channels.get(ck(c));
    if (!st) {
      st = {
        seenFader: null, seenOn: null, lastWriteAt: 0, pausedUntil: 0, noRaiseUntil: 0,
        blockedAt: null, speakingSince: null, lastActiveAt: this.io.now(), lastFeedbackAt: 0,
      };
      this.channels.set(ck(c), st);
    }
    return st;
  }

  private isOpen(c: ChannelId): boolean {
    return this.io.isOn(c) && (this.io.fader(c) ?? NEG_INF) >= this.config.minLevel * 100;
  }

  /** Fader or ON changed by someone else (console, another device): the person wins. */
  private detectManualChanges(now: number): void {
    for (const c of this.config.channels) {
      const st = this.state(c);
      const f = this.io.fader(c);
      const on = this.io.isOn(c);
      const talking = this.bestKey === ck(c);
      if (f !== undefined && st.seenFader !== null && faderDiffers(f, st.seenFader)) {
        st.pausedUntil = now + MANUAL_PAUSE_MS;
        st.lastActiveAt = Math.max(st.lastActiveAt, now); // a mic opened by hand stays open for closeAfter
        if (f < this.config.minLevel * 100 && f < st.seenFader) {
          // Pulled down by hand: keep it closed while somebody is still talking into it.
          if (talking) this.block(c, st, now, "von Hand zugezogen");
        } else if (talking && f >= this.config.minLevel * 100) {
          this.learn(c, f); // the person's correction is the better position for next time
        }
      }
      if (st.seenOn !== null && on !== st.seenOn && !on && talking) this.block(c, st, now, "von Hand ausgeschaltet");
      if (f !== undefined) st.seenFader = f;
      st.seenOn = on;
    }
  }

  private block(c: ChannelId, st: ChannelState, now: number, why: string): void {
    st.blockedAt = now;
    this.note(`${this.io.label(c)}: ${why} – bleibt zu, bis ${UNBLOCK_MS / 1000} s niemand hineinspricht.`);
  }

  /**
   * The loudest speaking mic, measured against its *own* noise floor (so a sensitive pulpit mic
   * with high gain is not outvoted by a mic that merely picks up the same voice). The current
   * speaker keeps the role until another mic is clearly louder.
   */
  private detectSpeaker(now: number): ChannelId | null {
    const levels = this.config.channels.map((c) => ({ c, ...this.meterLevel(c, now) }));
    for (const m of levels) {
      const st = this.state(m.c);
      st.speakingSince = m.speaking ? (st.speakingSince ?? now) : null;
    }
    const speakers = levels.filter((m) => m.speaking).sort((a, b) => (b.excess ?? 0) - (a.excess ?? 0));
    let best = speakers[0] ?? null;
    const prev = speakers.find((m) => ck(m.c) === this.bestKey);
    if (best && prev && prev !== best && (best.excess ?? 0) < (prev.excess ?? 0) + DOMINANCE) best = prev;
    this.bestKey = best ? ck(best.c) : null;
    if (best) this.state(best.c).lastActiveAt = now;
    for (const m of levels) {
      const st = this.state(m.c);
      if (st.blockedAt !== null && now - Math.max(st.blockedAt, st.lastActiveAt) >= UNBLOCK_MS) st.blockedAt = null;
    }
    return best?.c ?? null;
  }

  /** Current (peak-held) meter level, floor and excess of one mic. */
  private meterLevel(c: ChannelId, now: number): { level: number | null; floor: number | null; excess: number | null; speaking: boolean } {
    const h = this.meterHistory.get(ck(c));
    if (!h || !h.length || !this.meters || now - this.meters.t >= METER_STALE_MS) return { level: null, floor: null, excess: null, speaking: false };
    const floor = h.length >= 5 ? percentile(h.map((x) => x.v), MIC_FLOOR_PERCENTILE) : null;
    let level = h[h.length - 1].v;
    for (let i = h.length - 1; i >= 0 && h[i].t > now - HOLD_MS; i--) level = Math.max(level, h[i].v);
    const excess = floor === null ? null : level - floor;
    return { level, floor, excess, speaking: excess !== null && excess >= SPEAK_EXCESS };
  }

  /** Opens `c` (ON + fader to the learned/start position) if the speech is clear. Returns why not. */
  private tryOpen(c: ChannelId, now: number): string | null {
    const st = this.state(c);
    const name = this.io.label(c);
    if (st.blockedAt !== null) return `${name} spricht, wurde aber von Hand geschlossen – bleibt zu.`;
    if (st.pausedUntil > now) return `${name}: von Hand verstellt – Automatik pausiert kurz.`;
    if (this.noOpenUntil > now) return `${name} spricht – nach Rückkopplung wird kurz nichts geöffnet.`;
    const f = this.io.fader(c);
    if (f === undefined) return `${name} spricht – Faderstellung noch unbekannt.`;
    const me = this.meterLevel(c, now);
    const others = this.config.channels.filter((x) => ck(x) !== ck(c)).map((x) => this.meterLevel(x, now).excess ?? 0);
    const clear = (me.excess ?? 0) >= OPEN_EXCESS && others.every((e) => (me.excess ?? 0) >= e + DOMINANCE);
    if (!clear) return `${name}: Sprache erkannt, aber nicht eindeutig – Mikro bleibt zu.`;
    if (st.speakingSince === null || now - st.speakingSince < CONFIRM_MS) return `${name}: Sprache erkannt …`;

    const on = this.io.isOn(c);
    const min = this.config.minLevel * 100, max = this.maxLevel(c);
    const learned = this.config.learned[ck(c)];
    const level = Math.round(Math.min(max, Math.max(min, learned ?? this.config.startLevel * 100)) / 10) * 10;
    const actions: string[] = [];
    if (f < min) { this.io.setFader(c, level); actions.push(`Fader auf ${dbText(level)}${learned !== undefined ? " (gemerkt)" : ""}`); }
    if (!on) { this.io.setOn(c, true); actions.push("eingeschaltet"); }
    st.seenFader = this.io.fader(c) ?? null;
    st.seenOn = this.io.isOn(c);
    st.lastWriteAt = now;
    st.lastActiveAt = now;
    this.note(`${name} spricht – ${actions.join(", ")}.`);
    return null;
  }

  /** Pulls the fader of every selected mic down once nobody talked into it for `closeAfter` seconds. */
  private closeSilentMics(now: number): void {
    for (const c of this.config.channels) {
      const st = this.state(c);
      const f = this.io.fader(c);
      if (f === undefined || f <= NEG_INF || this.bestKey === ck(c) || now - st.lastActiveAt < this.config.closeAfter * 1000) continue;
      this.io.setFader(c, NEG_INF);
      st.seenFader = this.io.fader(c) ?? null;
      st.lastWriteAt = now;
      this.note(`${this.io.label(c)}: ${this.config.closeAfter} s still – Fader runter.`);
    }
  }

  /** Open speaker mics that take part in feedback (see FEEDBACK_WINDOW_MS). */
  private feedbackVictims(now: number, target: number | null): ChannelId[] {
    if (target === null) return [];
    const win = this.room.filter((s) => now - s.t <= FEEDBACK_WINDOW_MS);
    if (win.length < 5 || now - win[0].t < FEEDBACK_WINDOW_MS * 0.8) return [];
    const levels = win.map((s) => s.level);
    if (Math.max(...levels) - Math.min(...levels) > STEADY_DB || Math.min(...levels) < target + 3) return [];
    return this.config.channels.filter((c) => {
      const st = this.state(c);
      if (!this.io.isOn(c) || (this.io.fader(c) ?? NEG_INF) <= NEG_INF || now - st.lastFeedbackAt < FEEDBACK_COOLDOWN_MS) return false;
      const h = (this.meterHistory.get(ck(c)) ?? []).filter((x) => now - x.t <= FEEDBACK_WINDOW_MS);
      if (h.length < 5) return false;
      const v = h.map((x) => x.v);
      const floor = this.meterLevel(c, now).floor ?? 0;
      return Math.max(...v) - Math.min(...v) <= STEADY_DB && Math.min(...v) - floor >= SPEAK_EXCESS;
    });
  }

  /** Highest fader position for `c`: the ceiling or its feedback limit. */
  private maxLevel(c: ChannelId): number {
    return Math.min(this.config.ceiling * 100, this.config.limits[ck(c)] ?? Infinity);
  }

  private setLimit(c: ChannelId, raw: number): void {
    const v = Math.max(this.config.minLevel * 100, Math.round(raw / 10) * 10);
    const old = this.config.limits[ck(c)];
    if (old !== undefined && old <= v) return;
    this.config.limits[ck(c)] = v;
    const learned = this.config.learned[ck(c)];
    if (learned !== undefined && learned > v) this.config.learned[ck(c)] = v;
    this.onConfigChange?.();
  }

  /** Remembers the fader position that gives the target level for this mic. */
  private learn(c: ChannelId, f: number): void {
    if (f < this.config.minLevel * 100) return;
    const v = Math.min(Math.round(f / 10) * 10, this.maxLevel(c));
    const old = this.config.learned[ck(c)];
    if (old !== undefined && Math.abs(old - v) < 50) return;
    this.config.learned[ck(c)] = v;
    this.onConfigChange?.();
  }

  private micInfo(metersAvailable: boolean): MicInfo[] {
    const now = this.io.now();
    return this.config.channels.map((c) => {
      const key = ck(c);
      const st = this.channels.get(key);
      const m = metersAvailable ? this.meterLevel(c, now) : { level: null, floor: null, excess: null, speaking: false };
      const f = this.io.fader(c);
      const learned = this.config.learned[key];
      const limit = this.config.limits[key];
      return {
        key, label: this.io.label(c), ...m,
        on: this.io.isOn(c), open: this.isOpen(c),
        fader: f === undefined || f <= NEG_INF ? null : f / 100,
        blocked: st?.blockedAt != null && this.enabled,
        learned: learned === undefined ? null : learned / 100,
        limit: limit === undefined ? null : limit / 100,
        closesIn: st && this.enabled && this.bestKey !== key && f !== undefined && f > NEG_INF
          ? Math.max(0, Math.ceil((st.lastActiveAt + this.config.closeAfter * 1000 - now) / 1000)) : null,
      };
    });
  }

  /** Moves a fader by `deltaRaw` (0.01 dB) within [minLevel, ceiling]. Returns true if a limit was hit. */
  private move(c: ChannelId, st: ChannelState, deltaRaw: number, force: boolean): boolean {
    const f = this.io.fader(c);
    if (f === undefined || f <= NEG_INF) return false;
    const lo = this.config.minLevel * 100;
    const hi = this.maxLevel(c);
    let next = Math.round((f + deltaRaw) / 10) * 10;
    let limited = false;
    // Never push a fader back across a limit it already exceeds (e.g. set by hand).
    if (next > hi) { next = f > hi ? f : hi; limited = true; }
    if (next < lo && !force) { next = f < lo ? f : lo; limited = true; }
    if (next === f && !force) return limited;
    this.io.setFader(c, next);
    st.seenFader = this.io.fader(c) ?? null;
    st.lastWriteAt = this.io.now();
    return limited;
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
