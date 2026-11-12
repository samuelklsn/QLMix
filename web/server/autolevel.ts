// Raum-Automatik: runs unattended – one button, then it decides by itself.
//
// Inputs (all from the console's input meters, pre-EQ = before ON and fader):
//   - speaker mics: who is talking, and how loud (works while a channel is switched off),
//   - room mics hanging in the room: how loud it arrives (calibration and feedback only),
//   - every other input (instruments, choir, playback): is music playing?
//
// What it does:
//   - Opens a mic (ON + fader) only for real speech: sustained for a moment, close to the level
//     this mic normally gets when somebody talks into it (learned per mic), clearly louder than
//     the other speaker mics. Footsteps, people passing by or the congregation singing stay out.
//   - Sets the fader once per new speaker from the mic's own level (learned per mic: mic level +
//     fader = right loudness in the room), then holds it. Only a lasting deviation of more than
//     3 dB is corrected, slowly – no audible "pumping". Room mics slowly recalibrate that sum.
//   - Music (other inputs playing): nothing is opened unless somebody sings right into a speaker
//     mic, faders are not regulated.
//   - Pulls a speaker mic's fader down after `closeAfter` seconds without speech.
//   - Feedback (steady tone at room mic AND speaker mic): cut 6 dB, remember a per-mic limit.
//   - Manual moves win: 5 s pause, the new position is learned. ON switched off while talking:
//     stays off until it was quiet for a while.
//   - Stays on across restarts (`running`), emergency stop closes all speaker mics.

import { type ChannelId, levelToPosition } from "../shared/rcp.ts";

export type Sensitivity = "low" | "normal" | "high";

/** What QLMix learned about one speaker mic. */
export interface MicProfile {
  /** normal speaking level at this mic (dBFS, console meter before EQ) */
  speech: number;
  /** mic speaking level + fader (dB) that gives the target loudness in the room; null = not calibrated yet */
  sum: number | null;
  /** set by hand – the room mics do not recalibrate it (until "So soll es klingen" or "vergessen") */
  manual?: boolean;
}

export interface AutoConfig {
  /** speaker mics the automatic may switch on and move */
  channels: ChannelId[];
  /** room mics that measure the level in the room (never moved) */
  roomMics: ChannelId[];
  /** inputs that never count as music (e.g. a mic that is not a speaker mic but used for talking) */
  musicIgnore: ChannelId[];
  /** Reference room level (dBFS at the room mics) – set with "So soll es klingen". */
  reference: number | null;
  /** User offset in dB (louder / quieter than the reference). */
  offset: number;
  speed: number;       // 0.5 / 1 / 2 – slow corrections run at speed × 0.5 dB/s
  sensitivity: Sensitivity;
  ceiling: number;     // fader never above (dB)
  minLevel: number;    // fader never below while regulating (dB); below counts as "closed"
  startLevel: number;  // opening position (dB) for a mic without a learned position
  closeAfter: number;  // seconds without speech before a mic's fader goes down to −∞
  /** channel key → fader position (0.01 dB) that gave the target level last time */
  learned: Record<string, number>;
  /** channel key → highest fader position (0.01 dB) allowed – 3 dB below where it fed back */
  limits: Record<string, number>;
  /** channel key → learned speaking level and calibration */
  profiles: Record<string, MicProfile>;
  /** automatic is switched on – restored after a restart */
  running: boolean;
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  channels: [], roomMics: [], musicIgnore: [], reference: null, offset: 0, speed: 1, sensitivity: "normal",
  ceiling: 5, minLevel: -20, startLevel: -10, closeAfter: 30, learned: {}, limits: {}, profiles: {}, running: false,
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
  /** last action, shown for a few seconds */
  event: string | null;
  active: string | null;
  activeKey: string | null;
  room: { level: number | null; speech: number | null; floor: number | null; target: number | null; fresh: boolean };
  metersAvailable: boolean;
  feedback: boolean;
  /** music is playing (other inputs active) */
  music: boolean;
  /** names of the inputs that play */
  musicSources: string[];
  /** Per selected channel: what the detection sees (for the live display). */
  mics: MicInfo[];
  /** what happened, newest first (for checking from home) */
  history: { t: number; text: string }[];
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
  /** somebody talks into this mic (not just noise or the room) */
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
  /** learned normal speaking level (dBFS), null = still learning */
  speech: number | null;
  /** seconds until the fader goes down (open mic, nobody talking) */
  closesIn: number | null;
}

const ck = (c: ChannelId) => `${c.kind}:${c.index}`;
const fromKey = (k: string): ChannelId => { const [kind, i] = k.split(":"); return { kind: kind as ChannelId["kind"], index: Number(i) }; };
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
/** During music (sustained organ chords) feedback must be this far above the target. */
const FEEDBACK_MUSIC_DB = 10;
/** The limit is set this far below the position that fed back. */
const LIMIT_MARGIN_DB = 3;
const FEEDBACK_PAUSE_MS = 10000;
const FEEDBACK_COOLDOWN_MS = 1500;
const MANUAL_PAUSE_MS = 5000;
const WRITE_INTERVAL_MS = 200;
const EVENT_MS = 6000;
const HISTORY_MAX = 40;
/** Short peak hold on the console meter so the gaps between words don't count as silence. */
const HOLD_MS = 400;
/** A mic counts as "speaking" when it is this many dB above its own noise floor … */
export const SPEAK_EXCESS = 8;
/** … and (with a learned speaking level) at most this far below it – the congregation is further down. */
const IN_USE_BELOW_SPEECH = 15;
/** Without a learned speaking level: this far above the floor. */
const IN_USE_EXCESS = 15;
/** The current speaker keeps the role until another mic is this much louder. */
export const DOMINANCE = 6;
/** Opening: level at most this far below the learned speaking level (by sensitivity). */
const OPEN_BELOW_SPEECH: Record<Sensitivity, number> = { low: 8, normal: 12, high: 16 };
/** Opening without a learned speaking level: this far above the mic's floor. */
const OPEN_EXCESS: Record<Sensitivity, number> = { low: 24, normal: 20, high: 16 };
/** Opening needs sustained speech for this long … */
const CONFIRM_MS: Record<Sensitivity, number> = { low: 1000, normal: 700, high: 450 };
/** … with at least this share of meter frames close to the opening level (footsteps are short). */
const SPEECH_SHARE = 0.5;
const SHARE_WINDOW_MS = 800;
/** During music only somebody singing right into the mic opens it. */
const MUSIC_OPEN_BELOW_SPEECH = 6;
const MUSIC_OPEN_EXCESS = 26;
/** A mic switched off by hand may be reopened after this long without speech into it. */
export const UNBLOCK_MS = 10000;
/** A mic that was silent this long starts with a new speaker: set the fader once, quickly. */
const NEW_SPEAKER_GAP_MS = 5000;
const SETTLE_MS = 4000;
const SETTLE_RATE_DB = 3;
/** After settling: correct only lasting deviations above HOLD_START_DB, down to HOLD_STOP_DB. */
const HOLD_START_DB = 3;
const HOLD_STOP_DB = 1;
const HOLD_WINDOW_MS = 10000;
/** Room mics recalibrate a mic's sum by at most this much per second. */
const CAL_RATE_DB = 0.15;
/** Without calibration: the room must be on target this long before the sum is stored. */
const CAL_STABLE_MS = 3000;
/** Music: another input this far above its floor and above MUSIC_MIN_RAW counts as playing. */
const MUSIC_EXCESS = 15;
const MUSIC_MIN_RAW = 76; // −50 dBFS
const MUSIC_FLOOR_RISE_DB_S = 0.3;
const MUSIC_WINDOW_MS = 3000;
const MUSIC_SHARE = 0.4;
const MUSIC_HOLD_MS = 4000;

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
  /** since when the mic qualifies for opening (sustained speech) */
  candidateSince: number | null;
  /** last time this mic was the speaking mic */
  lastActiveAt: number;
  /** since when it is the speaking mic in this turn */
  activeSince: number;
  settleUntil: number;
  correcting: boolean;
  calOkMs: number;
  lastCalAt: number;
  lastProfileAt: number;
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
const signed = (db: number) => `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;

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
  private history: { t: number; text: string }[] = [];
  // music detection
  private otherFloor = new Map<string, number>();
  private lastMeterAt = 0;
  private musicFrames: { t: number; active: string[] }[] = [];
  private musicUntil = 0;
  private wasMusic = false;
  /** Optional hook (server log) when the detected speaker changes. */
  onActiveChange?: (label: string | null) => void;
  /** Optional hook for every history entry (server log). */
  onEvent?: (text: string) => void;
  /** Called when the config changed by itself (learned values, on/off) and should be saved. */
  onConfigChange?: () => void;

  private io: AutoIO;

  constructor(io: AutoIO, config: Partial<AutoConfig> = {}) {
    this.io = io;
    const c = { ...DEFAULT_AUTO_CONFIG, ...config };
    // Only known fields – drops settings of older versions (maxBoost/maxCut).
    this.config = {
      channels: c.channels, roomMics: c.roomMics, musicIgnore: c.musicIgnore, reference: c.reference, offset: c.offset,
      speed: c.speed, sensitivity: (["low", "normal", "high"] as const).includes(c.sensitivity) ? c.sensitivity : "normal",
      ceiling: c.ceiling, minLevel: c.minLevel, startLevel: c.startLevel, closeAfter: c.closeAfter,
      learned: { ...c.learned }, limits: { ...c.limits }, profiles: { ...c.profiles }, running: !!c.running,
    };
    this.status = this.emptyStatus("Aus");
  }

  // ------------------------------------------------------------ inputs

  /** Console input meters: channel key → raw meter value (0…126 = dBFS + 126). */
  setMeters(levels: Map<string, number>): void {
    const t = this.io.now();
    const dt = this.lastMeterAt ? Math.min(1, (t - this.lastMeterAt) / 1000) : 0.1;
    this.lastMeterAt = t;
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
    // Music: any other input clearly above its own (slowly tracked) floor.
    const own = new Set([...this.config.channels, ...this.config.roomMics, ...this.config.musicIgnore].map(ck));
    const active: string[] = [];
    for (const [k, v] of levels) {
      if (own.has(k)) continue;
      const f = Math.min(v, (this.otherFloor.get(k) ?? v) + MUSIC_FLOOR_RISE_DB_S * dt);
      this.otherFloor.set(k, f);
      if (v - f >= MUSIC_EXCESS && v >= MUSIC_MIN_RAW) active.push(k);
    }
    this.musicFrames.push({ t, active });
    while (this.musicFrames.length && this.musicFrames[0].t < t - MUSIC_WINDOW_MS) this.musicFrames.shift();
  }

  // ------------------------------------------------------------ control

  start(): string | null {
    if (this.config.roomMics.length === 0) return "Bitte zuerst die Raum-Mikrofone auswählen.";
    if (this.config.channels.length === 0) return "Bitte zuerst Sprecher-Mikrofone auswählen.";
    if (this.config.reference === null) return "Bitte zuerst „So soll es klingen“ festlegen.";
    const wasRunning = this.config.running;
    this.enabled = true;
    this.channels.clear();
    this.bestKey = null;
    this.config.running = true;
    if (!wasRunning) this.onConfigChange?.();
    this.note("Automatik gestartet.");
    return null;
  }

  stop(): void {
    if (this.enabled) this.note("Automatik gestoppt.");
    this.enabled = false;
    if (this.config.running) { this.config.running = false; this.onConfigChange?.(); }
    this.status = { ...this.status, enabled: false, message: "Aus", level: "info", event: null, history: [...this.history] };
  }

  /** Emergency: stop the automatic and pull every speaker mic's fader down. */
  panic(): void {
    this.stop();
    for (const c of this.config.channels) if ((this.io.fader(c) ?? NEG_INF) > NEG_INF) this.io.setFader(c, NEG_INF);
    this.note("Notaus: Automatik gestoppt, alle Sprecher-Mikros zu.");
    this.status = { ...this.status, history: [...this.history] };
  }

  /** Uses the current speech level as the target ("So soll es klingen"). */
  takeReference(): string | null {
    const speech = this.speechLevel();
    if (speech === null) return "Gerade wird nicht gesprochen – bitte während einer normalen Rede drücken.";
    this.config.reference = Math.round(speech * 10) / 10;
    this.config.offset = 0;
    // The calibration of every mic refers to the old target – learn it again.
    for (const p of Object.values(this.config.profiles)) { p.sum = null; p.manual = false; }
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
    const { music, sources } = this.musicState(now, metersAvailable);
    const victims = this.enabled && metersAvailable && fresh ? this.feedbackVictims(now, target, music) : [];
    const feedback = victims.length > 0;
    const roomStatus = { level: fresh ? this.room[this.room.length - 1].level : null, speech, floor, target, fresh };

    const set = (message: string, level: AutoStatus["level"], active: ChannelId | null = null) => {
      if (this.event && this.event.until < now) this.event = null;
      this.status = {
        enabled: this.enabled, room: roomStatus, metersAvailable, feedback, music, musicSources: sources,
        mics: this.micInfo(metersAvailable), history: [...this.history],
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
    if (music !== this.wasMusic) {
      this.wasMusic = music;
      this.note(music ? `Musik erkannt${sources.length ? ` (${sources.join(", ")})` : ""} – Mikros werden nur für direkten Gesang geöffnet.` : "Musik vorbei.");
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
      const why = this.tryOpen(best, now, music);
      if (why) return set(why, "info", best);
    }

    if (!best) {
      if (music) return set(`Musik erkannt${sources.length ? ` (${sources.join(", ")})` : ""} – Mikros bleiben, wie sie sind.`, "info");
      return set(fresh ? "Bereit – kein Mikrofon spricht gerade." : "Bereit – aber von den Raum-Mikros kommt kein Pegel. Ohne sie wird nur geöffnet, nicht eingemessen.", fresh ? "info" : "warn");
    }

    const st = this.state(best);
    const name = this.io.label(best);
    if (st.pausedUntil > now) return set(`${name}: von Hand verstellt – Automatik übernimmt gleich wieder.`, "info", best);
    if (music) return set(`${name} singt oder spricht zur Musik – Fader bleibt stehen.`, "info", best);
    const r = this.regulate(best, st, now, dt, { fresh, speech, target });
    return set(r.message, r.level, best);
  }

  // ------------------------------------------------------------ regulation

  /**
   * Once per new speaker: set the fader from the mic's own level (learned sum − speaking level),
   * then hold it and correct only lasting deviations, slowly. Without calibration yet, the room
   * mics are used directly until the room is on target – then the sum is stored.
   */
  private regulate(c: ChannelId, st: ChannelState, now: number, dt: number,
    room: { fresh: boolean; speech: number | null; target: number | null }): { message: string; level: AutoStatus["level"] } {
    const name = this.io.label(c);
    const key = ck(c);
    const f = this.io.fader(c);
    if (f === undefined || f <= NEG_INF) return { message: `${name} spricht – Fader ist zu.`, level: "info" };
    const settling = now < st.settleUntil;
    const L = this.micSpeech(c, now, settling ? st.activeSince : now - HOLD_WINDOW_MS);
    const profile = this.config.profiles[key];

    // Learn the normal speaking level of this mic.
    if (L !== null && now - st.lastProfileAt > 2000 && now - st.activeSince > 1500) {
      st.lastProfileAt = now;
      const speechNow = Math.round(L * 10) / 10;
      if (!profile) this.config.profiles[key] = { speech: speechNow, sum: null };
      else profile.speech = Math.round((profile.speech * 0.9 + speechNow * 0.1) * 10) / 10;
      this.onConfigChange?.();
    }

    const p = this.config.profiles[key];
    if (!p || p.sum === null) {
      // Not calibrated: follow the room mics until the room is on target.
      if (!room.fresh || room.speech === null || room.target === null || L === null) {
        return { message: `${name}: lerne die richtige Stellung – warte auf Sprache an den Raum-Mikros …`, level: "info" };
      }
      const error = room.target - room.speech;
      if (Math.abs(error) < DEADBAND) {
        st.calOkMs += dt * 1000;
        if (st.calOkMs >= CAL_STABLE_MS) {
          this.config.profiles[key] = { speech: p?.speech ?? L, sum: Math.round((L + f / 100) * 10) / 10 };
          this.learn(c, f);
          this.note(`${name}: richtige Stellung gelernt (${dbText(f)}).`);
          this.onConfigChange?.();
        }
        return { message: `${name}: Lautstärke passt – merke mir die Stellung …`, level: "ok" };
      }
      st.calOkMs = 0;
      if (error > 0 && st.noRaiseUntil > now) return { message: `${name}: nach Pfeifen kein Anheben.`, level: "warn" };
      const rate = settling ? SETTLE_RATE_DB : Math.max(1, this.config.speed);
      const limited = this.stepTowards(c, st, f + Math.round(error * 100), rate, now);
      if (limited) return { message: `${name}: Grenze erreicht (${this.limitText(c, error)}).`, level: "warn" };
      return { message: `${name}: lerne die richtige Stellung – ${error > 0 ? "ziehe hoch" : "nehme zurück"} (${signed(error)})`, level: "ok" };
    }

    // Calibrated: the room mics only nudge the sum slowly (room changes, more people …) – and
    // only while the fader rests, otherwise both loops would chase each other.
    if (!p.manual && room.fresh && room.speech !== null && room.target !== null && !settling && !st.correcting
      && now - st.activeSince > 5000 && now - st.lastCalAt >= 1000) {
      const err = room.target - room.speech;
      const elapsed = st.lastCalAt ? Math.min(2, (now - st.lastCalAt) / 1000) : 1;
      st.lastCalAt = now;
      if (Math.abs(err) > DEADBAND) {
        p.sum = Math.round((p.sum + Math.sign(err) * Math.min(Math.abs(err) * 0.1, CAL_RATE_DB * elapsed)) * 100) / 100;
        this.onConfigChange?.();
      }
    }
    if (L === null) return { message: `${name}: warte auf Sprache …`, level: "info" };

    const desired = Math.round((p.sum - L) * 100);
    const diff = (Math.min(desired, this.maxLevel(c)) - f) / 100;
    if (settling) {
      if (Math.abs(diff) <= HOLD_STOP_DB) { this.learn(c, f); return { message: `${name}: neuer Sprecher – Lautstärke passt.`, level: "ok" }; }
      if (diff > 0 && st.noRaiseUntil > now) return { message: `${name}: nach Pfeifen kein Anheben.`, level: "warn" };
      const limited = this.stepTowards(c, st, desired, SETTLE_RATE_DB, now);
      if (limited) return { message: `${name}: Grenze erreicht (${this.limitText(c, diff)}).`, level: "warn" };
      return { message: `${name}: neuer Sprecher – stelle ein (${signed(diff)})`, level: "ok" };
    }
    if (!st.correcting && Math.abs(diff) > HOLD_START_DB) st.correcting = true;
    if (st.correcting && Math.abs(diff) <= HOLD_STOP_DB) st.correcting = false;
    if (!st.correcting) {
      if (Math.abs(diff) <= HOLD_STOP_DB) this.learn(c, f);
      return { message: `${name}: Lautstärke passt – Fader bleibt ruhig.`, level: "ok" };
    }
    if (diff > 0 && st.noRaiseUntil > now) return { message: `${name}: nach Pfeifen kein Anheben.`, level: "warn" };
    const limited = this.stepTowards(c, st, desired, this.config.speed * 0.5, now);
    if (limited) { st.correcting = false; return { message: `${name}: Grenze erreicht (${this.limitText(c, diff)}).`, level: "warn" }; }
    return { message: `${name}: ${diff > 0 ? "spricht leiser – gleiche langsam an" : "spricht lauter – gleiche langsam an"} (${signed(diff)})`, level: "ok" };
  }

  /** Speaking level of a mic (dBFS) from its meter frames since `from`: 70th percentile of speech frames. */
  private micSpeech(c: ChannelId, now: number, from: number): number | null {
    const h = this.meterHistory.get(ck(c));
    const floor = this.meterLevel(c, now).floor;
    if (!h || floor === null) return null;
    const p = this.config.profiles[ck(c)];
    const lo = Math.max(floor + SPEAK_EXCESS, p ? p.speech + 126 - 20 : -Infinity);
    const frames = h.filter((x) => x.t >= from && x.v >= lo).map((x) => x.v);
    if (frames.length < 12) return null;
    return percentile(frames, 0.7) - 126;
  }

  private limitText(c: ChannelId, direction: number): string {
    const lim = this.config.limits[ck(c)];
    if (direction < 0) return `Fader nie unter ${dbText(this.config.minLevel * 100)}`;
    return lim !== undefined && lim < this.config.ceiling * 100 ? `Pfeifgrenze ${dbText(lim)}` : `Fader nie über ${dbText(this.config.ceiling * 100)}`;
  }

  /** Moves the fader towards `targetRaw` at `rateDb` per second. Returns true if a limit was hit. */
  private stepTowards(c: ChannelId, st: ChannelState, targetRaw: number, rateDb: number, now: number): boolean {
    const f = this.io.fader(c);
    if (f === undefined || f <= NEG_INF || now - st.lastWriteAt < WRITE_INTERVAL_MS) return false;
    const maxStep = rateDb * 100 * Math.min(1, st.lastWriteAt ? (now - st.lastWriteAt) / 1000 : 0.25);
    const delta = Math.sign(targetRaw - f) * Math.min(Math.abs(targetRaw - f), maxStep);
    return this.move(c, st, Math.round(delta), false);
  }

  // ------------------------------------------------------------ internals

  private emptyStatus(message: string): AutoStatus {
    return {
      enabled: false, message, level: "info", event: null, active: null, activeKey: null,
      room: { level: null, speech: null, floor: null, target: null, fresh: false },
      metersAvailable: false, feedback: false, music: false, musicSources: [], mics: [], history: [],
    };
  }

  private note(text: string): void {
    const t = this.io.now();
    this.event = { text, until: t + EVENT_MS };
    this.history.unshift({ t, text });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
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

  /** Music is playing when other inputs were active in a good share of the last seconds. */
  private musicState(now: number, metersAvailable: boolean): { music: boolean; sources: string[] } {
    if (!metersAvailable) return { music: false, sources: [] };
    const frames = this.musicFrames.filter((f) => now - f.t <= MUSIC_WINDOW_MS);
    const share = frames.length ? frames.filter((f) => f.active.length > 0).length / frames.length : 0;
    if (frames.length >= 5 && share >= MUSIC_SHARE) this.musicUntil = now + MUSIC_HOLD_MS;
    const music = now < this.musicUntil;
    if (!music) return { music, sources: [] };
    const count = new Map<string, number>();
    for (const f of frames) for (const k of f.active) count.set(k, (count.get(k) ?? 0) + 1);
    const sources = [...count].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => this.io.label(fromKey(k)));
    return { music, sources };
  }

  private state(c: ChannelId): ChannelState {
    let st = this.channels.get(ck(c));
    if (!st) {
      const now = this.io.now();
      st = {
        seenFader: null, seenOn: null, lastWriteAt: 0, pausedUntil: 0, noRaiseUntil: 0, lastFeedbackAt: 0,
        blockedAt: null, candidateSince: null, lastActiveAt: now, activeSince: now, settleUntil: 0, correcting: false,
        calOkMs: 0, lastCalAt: 0, lastProfileAt: 0,
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
        st.correcting = false;
        st.settleUntil = 0;
        st.lastActiveAt = Math.max(st.lastActiveAt, now); // a mic opened by hand stays open for closeAfter
        if (f < this.config.minLevel * 100 && f < st.seenFader) {
          // Pulled down by hand: keep it closed while somebody is still talking into it.
          if (talking) this.block(c, st, now, "von Hand zugezogen");
        } else if (talking && f >= this.config.minLevel * 100) {
          // The person's correction is the better position – also for this speaking level.
          this.learn(c, f);
          const L = this.micSpeech(c, now, now - HOLD_WINDOW_MS);
          const p = this.config.profiles[ck(c)];
          if (L !== null) this.config.profiles[ck(c)] = { speech: p?.speech ?? L, sum: Math.round((L + f / 100) * 10) / 10, manual: true };
          this.note(`${this.io.label(c)}: von Hand auf ${dbText(f)} – gemerkt.`);
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

  /** Somebody talks into this mic (not footsteps, not the congregation in the room). */
  private inUse(c: ChannelId, m: { level: number | null; excess: number | null }): boolean {
    if (m.level === null || m.excess === null || m.excess < SPEAK_EXCESS) return false;
    const p = this.config.profiles[ck(c)];
    return p ? m.level - 126 >= p.speech - IN_USE_BELOW_SPEECH : m.excess >= IN_USE_EXCESS;
  }

  /**
   * The speaking mic: in use and the loudest above its *own* noise floor (so a sensitive pulpit
   * mic with high gain is not outvoted by a mic that merely picks up the same voice). The current
   * speaker keeps the role until another mic is clearly louder.
   */
  private detectSpeaker(now: number): ChannelId | null {
    const levels = this.config.channels.map((c) => { const m = this.meterLevel(c, now); return { c, ...m, use: this.inUse(c, m) }; });
    const speakers = levels.filter((m) => m.use).sort((a, b) => (b.excess ?? 0) - (a.excess ?? 0));
    let best = speakers[0] ?? null;
    const prev = speakers.find((m) => ck(m.c) === this.bestKey);
    if (best && prev && prev !== best && (best.excess ?? 0) < (prev.excess ?? 0) + DOMINANCE) best = prev;
    if (best) {
      const st = this.state(best.c);
      if (this.bestKey !== ck(best.c) && now - st.lastActiveAt >= NEW_SPEAKER_GAP_MS) {
        // A new speaker (or the same after a long pause): set the fader once, quickly.
        st.activeSince = now;
        st.settleUntil = now + SETTLE_MS;
        st.correcting = false;
        st.calOkMs = 0;
      }
      st.lastActiveAt = now;
    }
    this.bestKey = best ? ck(best.c) : null;
    for (const m of levels) {
      const st = this.state(m.c);
      if (st.blockedAt !== null && now - Math.max(st.blockedAt, st.lastActiveAt) >= UNBLOCK_MS) st.blockedAt = null;
    }
    return best?.c ?? null;
  }

  /** Current (peak-held) meter level, floor and excess of one mic. */
  private meterLevel(c: ChannelId, now: number): { level: number | null; floor: number | null; excess: number | null } {
    const h = this.meterHistory.get(ck(c));
    if (!h || !h.length || !this.meters || now - this.meters.t >= METER_STALE_MS) return { level: null, floor: null, excess: null };
    const floor = h.length >= 5 ? percentile(h.map((x) => x.v), MIC_FLOOR_PERCENTILE) : null;
    let level = h[h.length - 1].v;
    for (let i = h.length - 1; i >= 0 && h[i].t > now - HOLD_MS; i--) level = Math.max(level, h[i].v);
    const excess = floor === null ? null : level - floor;
    return { level, floor, excess };
  }

  /** Raw meter level a mic must reach to be opened. */
  private openLevel(c: ChannelId, floor: number, music: boolean): number {
    const p = this.config.profiles[ck(c)];
    const s = this.config.sensitivity;
    if (p) return Math.max(floor + SPEAK_EXCESS + 4, p.speech + 126 - (music ? MUSIC_OPEN_BELOW_SPEECH : OPEN_BELOW_SPEECH[s]));
    return floor + (music ? MUSIC_OPEN_EXCESS : OPEN_EXCESS[s]);
  }

  /** Opens `c` (ON + fader to the learned/start position) if the speech is clear. Returns why not. */
  private tryOpen(c: ChannelId, now: number, music: boolean): string | null {
    const st = this.state(c);
    const name = this.io.label(c);
    if (st.blockedAt !== null) { st.candidateSince = null; return `${name} spricht, wurde aber von Hand geschlossen – bleibt zu.`; }
    if (st.pausedUntil > now) return `${name}: von Hand verstellt – Automatik übernimmt gleich wieder.`;
    if (this.noOpenUntil > now) return `${name} spricht – nach Pfeifen wird kurz nichts geöffnet.`;
    const f = this.io.fader(c);
    if (f === undefined) return `${name} spricht – Faderstellung noch unbekannt.`;

    // Sustained, close-up speech: level near the opening level for most of the last moment.
    const me = this.meterLevel(c, now);
    if (me.level === null || me.floor === null) return `${name}: lerne noch das Grundrauschen …`;
    const need = this.openLevel(c, me.floor, music);
    const recent = (this.meterHistory.get(ck(c)) ?? []).filter((x) => now - x.t <= SHARE_WINDOW_MS);
    const share = recent.length ? recent.filter((x) => x.v >= need - 6).length / recent.length : 0;
    const others = this.config.channels.filter((x) => ck(x) !== ck(c)).map((x) => this.meterLevel(x, now).excess ?? 0);
    const clear = me.level >= need && share >= SPEECH_SHARE && others.every((e) => (me.excess ?? 0) >= e + DOMINANCE);
    if (!clear) {
      st.candidateSince = null;
      return music ? `Musik erkannt – ${name} bleibt zu (nur direkter Gesang öffnet).` : `${name}: Geräusch oder leise Stimme – Mikro bleibt zu.`;
    }
    st.candidateSince ??= now;
    if (now - st.candidateSince < CONFIRM_MS[this.config.sensitivity]) return `${name}: Sprache erkannt …`;

    const on = this.io.isOn(c);
    const min = this.config.minLevel * 100, max = this.maxLevel(c);
    const p = this.config.profiles[ck(c)];
    const learned = this.config.learned[ck(c)];
    const fromProfile = p && p.sum !== null ? Math.round((p.sum - p.speech) * 100) : undefined;
    const pos = fromProfile ?? learned;
    const level = Math.round(Math.min(max, Math.max(min, pos ?? this.config.startLevel * 100)) / 10) * 10;
    const actions: string[] = [];
    if (f < min) { this.io.setFader(c, level); actions.push(`Fader auf ${dbText(level)}${pos !== undefined ? " (gemerkt)" : ""}`); }
    if (!on) { this.io.setOn(c, true); actions.push("eingeschaltet"); }
    st.seenFader = this.io.fader(c) ?? null;
    st.seenOn = this.io.isOn(c);
    st.lastWriteAt = now;
    st.lastActiveAt = now;
    st.activeSince = now;
    st.settleUntil = now + SETTLE_MS;
    st.candidateSince = null;
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
  private feedbackVictims(now: number, target: number | null, music: boolean): ChannelId[] {
    if (target === null) return [];
    const win = this.room.filter((s) => now - s.t <= FEEDBACK_WINDOW_MS);
    if (win.length < 5 || now - win[0].t < FEEDBACK_WINDOW_MS * 0.8) return [];
    const levels = win.map((s) => s.level);
    const above = music ? FEEDBACK_MUSIC_DB : 3;
    if (Math.max(...levels) - Math.min(...levels) > STEADY_DB || Math.min(...levels) < target + above) return [];
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
      const m = metersAvailable ? this.meterLevel(c, now) : { level: null, floor: null, excess: null };
      const f = this.io.fader(c);
      const learned = this.config.learned[key];
      const limit = this.config.limits[key];
      return {
        key, label: this.io.label(c), ...m, speaking: this.inUse(c, m),
        on: this.io.isOn(c), open: this.isOpen(c),
        fader: f === undefined || f <= NEG_INF ? null : f / 100,
        blocked: st?.blockedAt != null && this.enabled,
        learned: learned === undefined ? null : learned / 100,
        limit: limit === undefined ? null : limit / 100,
        speech: this.config.profiles[key]?.speech ?? null,
        closesIn: st && this.enabled && this.bestKey !== key && f !== undefined && f > NEG_INF
          ? Math.max(0, Math.ceil((st.lastActiveAt + this.config.closeAfter * 1000 - now) / 1000)) : null,
      };
    });
  }

  /** Moves a fader by `deltaRaw` (0.01 dB) within [minLevel, max]. Returns true if a limit was hit. */
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
