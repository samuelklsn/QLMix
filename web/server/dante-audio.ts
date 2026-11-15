// Dante audio for the Raum-Automatik: finds the Dante Virtual Soundcard on this PC, reads all of
// its receive channels with ffmpeg and analyses them (level, strongest frequency, feedback).
//
// Nothing has to be set up by hand: every DVS input device is read, every channel analysed, and
// each channel is matched to the console input it carries by comparing levels over time.
// ffmpeg is looked for in web/tools/ffmpeg (installed by the Windows update script), then in PATH.
//
// For testing without Dante, QLMIX_AUDIO_INPUT can hold ffmpeg input arguments as a JSON array,
// e.g. ["-re","-f","lavfi","-i","sine=frequency=2500"].

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ChannelAnalyzer, SAMPLE_RATE, type FeedbackHit } from "./spectrum.ts";

export interface DanteChannel {
  id: string;
  device: string;
  ch: number;
  /** channel number on the Dante Virtual Soundcard (from "DVS Receive 5-6" → 5, 6) */
  num: number;
  level: number | null;
  peak: number | null;
  /** console input this channel carries (matched by level), e.g. "CH 3 Raum" */
  match: string | null;
  /** carries a mix, a room mic or a speaker mic – only then can feedback be heard in it */
  relevant: boolean;
}

export interface DanteStatus {
  state: "off" | "no-ffmpeg" | "no-device" | "starting" | "running" | "error";
  message: string;
  /** some channel carries sound */
  receiving: boolean;
  /** some channel carries a mix / room mic / speaker mic → feedback protection over Dante works */
  useful: boolean;
  devices: string[];
  channels: DanteChannel[];
}

const RESTART_MS = 10000;
const SILENT_DB = -80;

/** Layout names ffmpeg prints → channel count. */
const LAYOUTS: Record<string, number> = { mono: 1, stereo: 2, "2.1": 3, "3.0": 3, quad: 4, "4.0": 4, "5.0": 5, "5.1": 6, "6.1": 7, "7.1": 8 };

export function parseChannels(stderr: string): number | null {
  const m = /Audio: [^,]+, \d+ Hz, ([^,\n]+)/.exec(stderr);
  if (!m) return null;
  const s = m[1].trim().replace(/\(.*\)$/, "");
  const n = /^(\d+) channels/.exec(s);
  if (n) return Number(n[1]);
  return LAYOUTS[s] ?? null;
}

/** DirectShow audio device names from `ffmpeg -list_devices true -f dshow -i dummy` (old and new output). */
export function parseDshowDevices(stderr: string): string[] {
  const out: string[] = [];
  let audioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) { audioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { audioSection = false; continue; }
    if (/Alternative name/i.test(line)) continue;
    const m = /"([^"]+)"\s*(\((audio|video|none)\))?\s*$/.exec(line);
    if (!m) continue;
    if (m[3] === "audio" || (!m[3] && audioSection)) out.push(m[1]);
  }
  return [...new Set(out)];
}

export const isDanteDevice = (name: string) => /dante|dvs/i.test(name);

/** First DVS channel of a device: "DVS Receive  5-6 (Dante Virtual Soundcard)" → 5, else 1. */
export function firstChannel(device: string): number {
  const m = /(\d+)\s*-\s*\d+/.exec(device.replace(/\(.*\)/, ""));
  return m ? Number(m[1]) : 1;
}

/** Pearson correlation of two equally long series. */
function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa < 1e-9 || sbb < 1e-9 ? 0 : sab / Math.sqrt(saa * sbb);
}

/**
 * Which console input does an audio channel carry? Compares the level course (dB, one value per
 * step) with every input's meter course. Needs movement (not just noise) and a clear winner.
 */
export function bestMatch(audio: number[], inputs: Map<string, number[]>, minCorr = 0.75): string | null {
  const ranked = rankMatches(audio, inputs);
  if (!ranked.length || ranked[0].corr < minCorr) return null;
  // A mix contains its sources: when a MIX/MTX follows as closely as the best single input, the
  // channel most likely carries that mix (only one source was playing).
  const mix = ranked.find((r) => /^(mix|matrix):/.test(r.key));
  if (mix && mix.corr >= minCorr && mix.corr >= ranked[0].corr - 0.1) return mix.key;
  const second = ranked[1]?.corr ?? -1;
  return ranked[0].corr - second >= 0.05 ? ranked[0].key : null;
}

/**
 * What a Dante channel carries, judged safely: all sources that fit about as well as the best one
 * (within 0.05) are considered. Only when ALL of them are relevant (a mix, a room or speaker mic) the
 * channel counts as relevant; when all are irrelevant it does not; a mixed result (e.g. only the
 * sampler plays – the sampler input and the mix it feeds fit equally) keeps the previous verdict.
 */
export function classifyMatch(
  ranked: { key: string; corr: number }[], isRelevant: (key: string) => boolean, previous: boolean | null, minCorr = 0.75,
): { key: string; relevant: boolean | null } | null {
  if (!ranked.length || ranked[0].corr < minCorr) return null;
  const top = ranked.filter((r) => r.corr >= ranked[0].corr - 0.05);
  const rel = top.filter((r) => isRelevant(r.key));
  const relevant = rel.length === top.length ? true : rel.length === 0 ? false : previous;
  return { key: (relevant ? rel[0] : top[0]).key, relevant };
}

/** All candidates sorted by correlation with the audio level course (needs movement, ≥ 5 s). */
export function rankMatches(audio: number[], inputs: Map<string, number[]>): { key: string; corr: number }[] {
  if (audio.length < 50) return [];
  const spread = Math.max(...audio) - Math.min(...audio);
  if (spread < 12) return [];
  const out: { key: string; corr: number }[] = [];
  for (const [key, series] of inputs) if (series.length === audio.length) out.push({ key, corr: correlation(audio, series) });
  return out.sort((a, b) => b.corr - a.corr);
}

interface Capture { device: string; proc: ChildProcess; analyzer: ChannelAnalyzer | null; err: string }

export class DanteAudio extends EventEmitter {
  status: DanteStatus = { state: "off", message: "Aus", receiving: false, useful: false, devices: [], channels: [] };
  private captures: Capture[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private ffmpeg: string | null = null;
  private root: string;
  /** level history per channel id (dB, one value per `sample()` call) */
  readonly history = new Map<string, number[]>();
  private matches = new Map<string, { label: string; relevant: boolean }>();
  /** supplies the "music is playing" flag for the detector */
  music: () => boolean = () => false;

  constructor(root: string) {
    super();
    this.root = root;
  }

  start(): void {
    this.running = true;
    this.launch();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    for (const c of this.captures) c.proc.kill();
    this.captures = [];
    this.set("off", "Aus");
  }

  /** Sets the console source a channel carries (from `bestMatch`) and whether feedback can be heard in it. */
  setMatch(id: string, label: string | null, relevant = false): void {
    if (label) this.matches.set(id, { label, relevant }); else this.matches.delete(id);
  }

  /** Previous relevance verdict of a channel (null = unknown). */
  relevance(id: string): boolean | null {
    return this.matches.has(id) ? this.matches.get(id)!.relevant : null;
  }

  /** Feedback in this channel means feedback in the room (it carries a mix, room or speaker mic). */
  isRelevant(id: string): boolean {
    return this.matches.get(id)?.relevant ?? false;
  }

  /** Called every 100 ms: records the current level of every channel for matching. */
  sample(maxLen: number): void {
    for (const ch of this.status.channels) {
      const h = this.history.get(ch.id) ?? [];
      h.push(ch.level ?? -120);
      if (h.length > maxLen) h.shift();
      this.history.set(ch.id, h);
    }
  }

  private set(state: DanteStatus["state"], message: string): void {
    this.status = { ...this.status, state, message };
  }

  private findFfmpeg(): string | null {
    const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const candidates = [process.env.QLMIX_FFMPEG, path.join(this.root, "tools", "ffmpeg", "bin", exe), path.join(this.root, "tools", "ffmpeg", exe), "ffmpeg"];
    for (const c of candidates) {
      if (!c) continue;
      if (c !== "ffmpeg" && !fs.existsSync(c)) continue;
      try { if (spawnSync(c, ["-hide_banner", "-version"], { timeout: 5000 }).status === 0) return c; } catch { /* next */ }
    }
    return null;
  }

  private retry(): void {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.launch(), RESTART_MS);
  }

  private launch(): void {
    for (const c of this.captures) c.proc.kill();
    this.captures = [];
    this.ffmpeg ??= this.findFfmpeg();
    if (!this.ffmpeg) {
      this.set("no-ffmpeg", "ffmpeg fehlt auf diesem PC – es wird beim nächsten Update automatisch installiert.");
      return this.retry();
    }
    let inputs: { device: string; args: string[] }[] = [];
    const test = process.env.QLMIX_AUDIO_INPUT;
    if (test) inputs = [{ device: "Test", args: JSON.parse(test) }];
    else if (process.platform === "win32") {
      const r = spawnSync(this.ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { encoding: "utf8", timeout: 15000 });
      const devices = parseDshowDevices(`${r.stderr ?? ""}\n${r.stdout ?? ""}`);
      this.status = { ...this.status, devices };
      inputs = devices.filter(isDanteDevice).map((d) => ({ device: d, args: ["-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${d}`] }));
    }
    if (!inputs.length) {
      this.set("no-device", process.platform === "win32"
        ? "Keine Dante Virtual Soundcard gefunden. Sie muss laufen und im Modus WDM stehen."
        : "Dante-Ton gibt es nur auf dem Windows-PC.");
      return this.retry();
    }
    this.set("starting", "Verbinde mit der Dante-Soundkarte …");
    for (const input of inputs) this.capture(input.device, input.args);
  }

  private capture(device: string, args: string[]): void {
    const proc = spawn(this.ffmpeg!, ["-hide_banner", "-nostdin", ...args, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", String(SAMPLE_RATE), "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const cap: Capture = { device, proc, analyzer: null, err: "" };
    this.captures.push(cap);
    proc.stderr!.on("data", (d: Buffer) => {
      cap.err = (cap.err + d.toString()).slice(-4000);
      if (!cap.analyzer) {
        const out = cap.err.lastIndexOf("Output #0");
        const n = out >= 0 ? parseChannels(cap.err.slice(out)) : null;
        if (n) {
          cap.analyzer = new ChannelAnalyzer(n);
          this.rebuildChannels();
          this.set("running", "");
        }
      }
    });
    proc.stdout!.on("data", (d: Buffer) => {
      const a = cap.analyzer;
      if (!a) return;
      a.write(d, () => Date.now(), this.music, (ch, level, hit) => {
        const id = `${device}#${ch + 1}`;
        const c = this.status.channels.find((x) => x.id === id);
        if (c) {
          const m = this.matches.get(id);
          c.level = Math.round(level * 10) / 10; c.peak = level > SILENT_DB ? Math.round(a.peaks[ch]) : null;
          c.match = m?.label ?? null; c.relevant = m?.relevant ?? false;
        }
        if (hit) this.emit("feedback", { id, ...hit } satisfies FeedbackHit & { id: string });
      });
      this.updateMessage();
    });
    proc.on("exit", () => {
      if (!this.running) return;
      const why = cap.err.split(/\r?\n/).filter((l) => /error|denied|could not|cannot|failed|i\/o/i.test(l)).slice(-2).join(" · ");
      this.captures = this.captures.filter((c) => c !== cap);
      this.rebuildChannels();
      this.set("error", `Dante-Ton „${device}“ kann nicht gelesen werden${why ? `: ${why}` : ""}. Neuer Versuch in ${RESTART_MS / 1000} s.`);
      if (!this.captures.length) this.retry();
    });
  }

  private rebuildChannels(): void {
    const channels: DanteChannel[] = [];
    for (const c of this.captures) {
      if (!c.analyzer) continue;
      for (let i = 0; i < c.analyzer.channels; i++) {
        const id = `${c.device}#${i + 1}`;
        const old = this.status.channels.find((x) => x.id === id);
        channels.push(old ?? { id, device: c.device, ch: i + 1, num: firstChannel(c.device) + i, level: null, peak: null, match: null, relevant: false });
      }
    }
    this.status = { ...this.status, channels: channels.sort((a, b) => a.num - b.num) };
  }

  private updateMessage(): void {
    if (this.status.state !== "running") return;
    const live = this.status.channels.filter((c) => (c.level ?? -120) > SILENT_DB);
    const useful = this.status.channels.filter((c) => c.relevant);
    this.status.receiving = live.length > 0;
    this.status.useful = useful.length > 0;
    this.status.message = useful.length
      ? `Pfeifschutz über Dante aktiv: ${useful.map((c) => c.match).filter((x, i, a) => a.indexOf(x) === i).join(", ")}.`
      : live.length
        ? `Dante-Ton kommt an (${live.length} von ${this.status.channels.length} Kanälen), aber darauf liegt kein Mix und kein Raum- oder Sprecher-Mikro – darin ist Pfeifen nicht zu hören. Der Pfeifschutz läuft über die Pult-Pegel.`
        : "Mit der Dante-Soundkarte verbunden, aber es kommt kein Ton an. Der Pfeifschutz läuft über die Pult-Pegel.";
  }
}
