// Yamaha RCP (Remote Control Protocol) – shared between server and browser.
// Text protocol over TCP 49280. See ../../README.md for details.

// ---------------------------------------------------------------- Tokenizer

export interface Token {
  text: string;
  quoted: boolean;
}

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  let escaping = false;
  for (const ch of line) {
    if (inQuotes) {
      if (escaping) {
        current += ch;
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        tokens.push({ text: current, quoted: true });
        current = "";
        inQuotes = false;
        hasToken = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      if (hasToken) tokens.push({ text: current, quoted: false });
      current = "";
      inQuotes = true;
      hasToken = false;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (hasToken) {
        tokens.push({ text: current, quoted: false });
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (inQuotes) tokens.push({ text: current, quoted: true });
  else if (hasToken) tokens.push({ text: current, quoted: false });
  return tokens;
}

export function quote(value: string): string {
  return '"' + value.replace(/[\\"]/g, (m) => "\\" + m) + '"';
}

// ---------------------------------------------------------------- Messages

export type Value = number | string;

export function encodeValue(v: Value): string {
  return typeof v === "number" ? String(Math.round(v)) : quote(v);
}

export type Status = "OK" | "OKm" | "NOTIFY" | "ERROR";

export type Message =
  | { kind: "param"; status: Status; command: string; address: string; x: number; y: number; value: Value }
  | { kind: "meter"; address: string; values: number[] }
  | { kind: "scene"; status: Status; command: string; number: number }
  | { kind: "info"; status: Status; command: string; args: string[] }
  | { kind: "error"; command: string; reason: string }
  | { kind: "unknown"; line: string };

function parseStatus(s: string): Status | null {
  switch (s.toUpperCase()) {
    case "OK": return "OK";
    case "OKM": return "OKm";
    case "NOTIFY": return "NOTIFY";
    case "ERROR": return "ERROR";
    default: return null;
  }
}

export function parseLine(line: string): Message {
  const t = tokenize(line);
  const status = t.length >= 2 ? parseStatus(t[0].text) : null;
  if (!status) return { kind: "unknown", line };
  const command = t[1].text;
  if (status === "ERROR") {
    return { kind: "error", command, reason: t.slice(2).map((x) => x.text).join(" ") };
  }
  if (command === "get" || command === "set") {
    const x = Number(t[3]?.text), y = Number(t[4]?.text);
    if (t.length >= 6 && Number.isInteger(x) && Number.isInteger(y)) {
      const vt = t[5];
      const n = Number(vt.text);
      const value: Value = !vt.quoted && vt.text !== "" && Number.isInteger(n) ? n : vt.text;
      return { kind: "param", status, command, address: t[2].text, x, y, value };
    }
    return { kind: "info", status, command, args: t.slice(2).map((x) => x.text) };
  }
  if (command === "mtr") {
    if (t.length < 3) return { kind: "unknown", line };
    return { kind: "meter", address: t[2].text, values: decodeMeter(t.slice(3)) };
  }
  if (command.startsWith("ss") && t.length >= 4 && Number.isInteger(Number(t[3].text))) {
    return { kind: "scene", status, command, number: Number(t[3].text) };
  }
  return { kind: "info", status, command, args: t.slice(2).map((x) => x.text) };
}

function decodeMeter(tokens: Token[]): number[] {
  const out: number[] = [];
  for (const { text } of tokens) {
    if (!text || !/^[0-9a-fA-F]+$/.test(text)) continue;
    if (text.length <= 2) out.push(parseInt(text, 16));
    else if (text.length % 2 === 0) for (let i = 0; i < text.length; i += 2) out.push(parseInt(text.slice(i, i + 2), 16));
  }
  return out;
}

// Commands (lines without trailing newline)
export const cmd = {
  get: (address: string, x: number, y: number) => `get ${address} ${x} ${y}`,
  set: (address: string, x: number, y: number, v: Value) => `set ${address} ${x} ${y} ${encodeValue(v)}`,
  sceneRecall: (n: number) => `ssrecall_ex MIXER:Lib/Scene ${n}`,
  sceneCurrent: () => `sscurrent_ex MIXER:Lib/Scene`,
  meterStart: (address: string, ms: number) => `mtrstart ${address} ${ms}`,
};

// ---------------------------------------------------------------- Parameter keys

/** Wire key: "address x y" – the unit the server caches and clients exchange. */
export type Key = string;
export const key = (address: string, x: number, y: number): Key => `${address} ${x} ${y}`;
export function splitKey(k: Key): { address: string; x: number; y: number } {
  const [address, x, y] = k.split(" ");
  return { address, x: Number(x), y: Number(y) };
}

export const PREFIX = "MIXER:Current/";

export type Kind = "input" | "stereoInput" | "mix" | "matrix" | "stereo" | "mono" | "dca";
export const KINDS: Kind[] = ["input", "stereoInput", "mix", "matrix", "stereo", "mono", "dca"];

export const KIND_INFO: Record<Kind, { segment: string; prefix: string; label: string }> = {
  input: { segment: "InCh", prefix: "CH", label: "Input" },
  stereoInput: { segment: "StInCh", prefix: "ST IN", label: "ST IN" },
  mix: { segment: "Mix", prefix: "MIX", label: "Mix" },
  matrix: { segment: "Mtrx", prefix: "MTX", label: "Matrix" },
  stereo: { segment: "St", prefix: "ST", label: "Stereo" },
  mono: { segment: "St", prefix: "MONO", label: "Mono" },
  dca: { segment: "DCA", prefix: "DCA", label: "DCA" },
};

export interface ChannelId {
  kind: Kind;
  index: number;
}

export const channelId = (kind: Kind, index: number): ChannelId => ({ kind, index });
export const channelKey = (c: ChannelId) => `${c.kind}:${c.index}`;
export function channelLabel(c: ChannelId): string {
  if (c.kind === "stereo" || c.kind === "mono") return KIND_INFO[c.kind].prefix;
  return `${KIND_INFO[c.kind].prefix} ${c.index + 1}`;
}

/** Wire indices (x) for a logical strip: stereo inputs are L/R pairs, St = [L, R, Mono]. */
export function wireIndices(c: ChannelId): number[] {
  switch (c.kind) {
    case "stereoInput": return [c.index * 2, c.index * 2 + 1];
    case "stereo": return [0, 1];
    case "mono": return [2];
    default: return [c.index];
  }
}

export const canSend = (k: Kind) => k === "input" || k === "stereoInput";
export const hasGain = (k: Kind) => k === "input" || k === "stereoInput";
export const hasEQ = (k: Kind) => k !== "dca";

export type ChannelParam = "level" | "on" | "name" | "color" | "cue" | "gain";

export function channelAddress(c: ChannelId, p: ChannelParam): string {
  const seg = KIND_INFO[c.kind].segment;
  switch (p) {
    case "level": return `${PREFIX}${seg}/Fader/Level`;
    case "on": return `${PREFIX}${seg}/Fader/On`;
    case "name": return `${PREFIX}${seg}/Label/Name`;
    case "color": return `${PREFIX}${seg}/Label/Color`;
    case "cue": return `${PREFIX}Cue/${seg}/On`;
    case "gain": return `${PREFIX}${seg}/Port/HA/Gain`;
  }
}

export const sendAddress = (c: ChannelId, p: "level" | "on") =>
  `${PREFIX}${KIND_INFO[c.kind].segment}/ToMix/${p === "level" ? "Level" : "On"}`;

/** Primary key used to read a channel parameter. */
export const channelParamKey = (c: ChannelId, p: ChannelParam): Key => key(channelAddress(c, p), wireIndices(c)[0], 0);
export const sendKey = (c: ChannelId, mix: number, p: "level" | "on"): Key => key(sendAddress(c, p), wireIndices(c)[0], mix);

/** All wire keys to write for a logical channel parameter (both halves of stereo pairs). */
export const channelWriteKeys = (c: ChannelId, p: ChannelParam): Key[] =>
  wireIndices(c).map((x) => key(channelAddress(c, p), x, 0));
export const sendWriteKeys = (c: ChannelId, mix: number, p: "level" | "on"): Key[] =>
  wireIndices(c).map((x) => key(sendAddress(c, p), x, mix));

// ---------------------------------------------------------------- Console models

export interface ConsoleModel {
  name: string;
  counts: Record<Kind, number>;
}

function model(name: string, inputs: number, mixes: number): ConsoleModel {
  return { name, counts: { input: inputs, stereoInput: 8, mix: mixes, matrix: 8, stereo: 1, mono: 1, dca: 16 } };
}

export const MODELS: ConsoleModel[] = [model("QL5", 64, 16), model("QL1", 32, 16), model("CL5", 72, 24), model("CL3", 64, 24), model("CL1", 48, 24)];

export function modelFromProductName(name: string): ConsoleModel {
  const upper = name.toUpperCase();
  return MODELS.find((m) => upper.includes(m.name)) ?? MODELS[0];
}

export function channelsOf(m: ConsoleModel, kind: Kind): ChannelId[] {
  return Array.from({ length: m.counts[kind] }, (_, i) => channelId(kind, i));
}

export const allChannels = (m: ConsoleModel) => KINDS.flatMap((k) => channelsOf(m, k));

// ---------------------------------------------------------------- Levels & fader law

export const NEG_INF = -32768;
export const LEVEL_MAX = 1000;
export const LEVEL_MIN = -13800;

export function clampLevel(raw: number): number {
  if (raw <= NEG_INF || raw < LEVEL_MIN) return NEG_INF;
  return Math.min(Math.round(raw), LEVEL_MAX);
}

export function levelText(raw: number | undefined): string {
  if (raw === undefined) return "–";
  if (raw <= NEG_INF || raw < LEVEL_MIN) return "-∞";
  const db = Math.round(raw / 10) / 10;
  return (db > 0 ? "+" : "") + db.toFixed(1).replace("-0.0", "0.0");
}

const TAPER: [number, number][] = [
  [0.0, -138], [0.02, -90], [0.06, -70], [0.12, -60], [0.2, -50], [0.28, -40], [0.38, -30],
  [0.48, -20], [0.56, -15], [0.64, -10], [0.71, -5], [0.78, 0], [0.89, 5], [1.0, 10],
];

export function levelToPosition(raw: number | undefined): number {
  if (raw === undefined || raw <= NEG_INF || raw < LEVEL_MIN) return 0;
  const db = raw / 100;
  const floor = 0.006;
  if (db <= TAPER[0][1]) return floor;
  if (db >= 10) return 1;
  for (let i = 1; i < TAPER.length; i++) {
    if (db <= TAPER[i][1]) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      return Math.max(floor, p0 + ((db - d0) / (d1 - d0)) * (p1 - p0));
    }
  }
  return 1;
}

export function positionToLevel(pos: number): number {
  const p = Math.min(Math.max(pos, 0), 1);
  if (p <= 0.005) return NEG_INF;
  let db = 10;
  for (let i = 1; i < TAPER.length; i++) {
    if (p <= TAPER[i][0]) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      db = d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
      break;
    }
  }
  const step = db < -40 ? 0.5 : 0.1;
  return clampLevel(Math.round(db / step) * step * 100);
}

/** Fader scale marks (dB, label). */
export const FADER_MARKS: [number | null, string][] = [
  [10, "+10"], [5, "+5"], [0, "0"], [-5, "5"], [-10, "10"], [-20, "20"], [-30, "30"], [-40, "40"], [-60, "60"], [null, "∞"],
];

// ---------------------------------------------------------------- Head amp gain

/** HA gain: 0.01 dB units, −6 … +66 dB. */
export const GAIN_MIN = -600;
export const GAIN_MAX = 6600;
export const gainText = (raw: number | undefined) => (raw === undefined ? "–" : `${raw > 0 ? "+" : ""}${Math.round(raw / 100)} dB`);

// ---------------------------------------------------------------- Colors

export const LABEL_COLORS = ["Blue", "Orange", "Yellow", "Purple", "Cyan", "Magenta", "Red", "Green", "Off"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const COLOR_HEX: Record<LabelColor, string> = {
  Blue: "#3a6dff", Orange: "#ff8c1a", Yellow: "#f5d726", Purple: "#9e52eb", Cyan: "#26d8f2",
  Magenta: "#f54dc7", Red: "#f2383a", Green: "#40d159", Off: "#5a5a61",
};

export function normalizeColor(v: string | undefined): LabelColor {
  if (!v) return "Off";
  const l = v.toLowerCase();
  if (l === "skyblue") return "Cyan";
  if (l === "pink") return "Magenta";
  return (LABEL_COLORS.find((c) => c.toLowerCase() === l) ?? "Off") as LabelColor;
}

export const darkTextColors: LabelColor[] = ["Yellow", "Cyan", "Green", "Orange"];

// ---------------------------------------------------------------- Meters

export const METER_SOURCES: { address: string; kind: Kind }[] = [
  { address: "MIXER:Current/Mix/PostOn", kind: "mix" },
  { address: "MIXER:Current/Mtrx/PostOn", kind: "matrix" },
];

export function meterKind(address: string): Kind | null {
  const a = address.replace("Current/Meter/", "Current/");
  return METER_SOURCES.find((s) => s.address === a)?.kind ?? null;
}

/** Raw meter value (0…127, 126 = 0 dBFS) → 0…1 over −60…0 dB. */
export function meterNorm(raw: number): number {
  const db = raw - 126;
  if (db <= -60) return 0;
  return Math.min(1, (db + 60) / 60);
}

// ---------------------------------------------------------------- EQ

/**
 * Two EQ backends:
 * - "rcp": EQ addresses on the RCP text protocol (RIVAGE/DM7 style; also the simulator).
 *   CL/QL consoles do NOT expose EQ there (confirmed with a QL5 V5.80a parameter dump).
 * - "ql": CL/QL editor protocol – MIDI Parameter Change SysEx over TCP port 50000
 *   (F0 43 1n 3E 19 01 <elem> <index> <channel> <5 data bytes> F7), as used by QL Editor/StageMix.
 *   Element numbers and value tables were taken from QL Editor V5.8.1 and verified on a QL5.
 */
export interface EqSchema {
  name: string;
  kind: "rcp" | "ql";
  segment: string;
  freqScale: number;
  gainScale: number;
  qScale: number;
  /** "ql": number of mono inputs (stereo inputs follow as L/R pairs). */
  inputCount?: number;
}

export const QL_SCHEMA: EqSchema = { name: "QL", kind: "ql", segment: "", freqScale: 1, gainScale: 10, qScale: 1 };

export const EQ_SCHEMAS: EqSchema[] = [
  { name: "PEQ", kind: "rcp", segment: "PEQ", freqScale: 10, gainScale: 100, qScale: 1000 },
  { name: "EQ", kind: "rcp", segment: "EQ", freqScale: 10, gainScale: 100, qScale: 1000 },
  QL_SCHEMA,
];

/** QL frequency table: 1/12-octave steps, index 0 = 16 Hz … index 124 = 20 kHz. */
export const QL_FREQ: number[] = [
  16, 17, 18, 19,
  20, 21.2, 22.4, 23.6, 25, 26.5, 28, 30, 31.5, 33.5, 35.5, 37.5,
  40, 42.5, 45, 47.5, 50, 53, 56, 60, 63, 67, 71, 75,
  80, 85, 90, 95, 100, 106, 112, 118, 125, 132, 140, 150,
  160, 170, 180, 190, 200, 212, 224, 236, 250, 265, 280, 300,
  315, 335, 355, 375, 400, 425, 450, 475, 500, 530, 560, 600,
  630, 670, 710, 750, 800, 850, 900, 950, 1000, 1060, 1120, 1180,
  1250, 1320, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2120, 2240, 2360,
  2500, 2650, 2800, 3000, 3150, 3350, 3550, 3750, 4000, 4250, 4500, 4750,
  5000, 5300, 5600, 6000, 6300, 6700, 7100, 7500, 8000, 8500, 9000, 9500,
  10000, 10600, 11200, 11800, 12500, 13200, 14000, 15000, 16000, 17000, 18000, 19000,
  20000,
];

/** QL Q table: index 0 = 16 (narrow) … index 44 = 0.10 (wide). */
export const QL_Q: number[] = [
  16, 14, 12, 11, 10, 9, 8, 7, 6.3, 5.6, 5, 4.5, 4, 3.5, 3.2, 2.8, 2.5, 2.2, 2, 1.8, 1.6, 1.4, 1.2,
  1.1, 1, 0.9, 0.8, 0.7, 0.63, 0.56, 0.5, 0.45, 0.4, 0.35, 0.32, 0.28, 0.25, 0.22, 0.2, 0.18, 0.16, 0.14,
  0.13, 0.11, 0.1,
];

const QL_HPF_MIN = 4;  // 20 Hz
const QL_HPF_MAX = 63; // 600 Hz

function nearestIndex(table: number[], v: number, lo = 0, hi = table.length - 1): number {
  let best = lo;
  for (let i = lo; i <= hi; i++) if (Math.abs(Math.log(table[i] / v)) < Math.abs(Math.log(table[best] / v))) best = i;
  return best;
}

export const EQ_BANDS = 4;
export type EqParam =
  | { p: "on" } | { p: "lowShelf" } | { p: "highShelf" } | { p: "hpfOn" } | { p: "hpfFreq" }
  | { p: "freq"; band: number } | { p: "gain"; band: number } | { p: "q"; band: number };

export const EQ_PARAMS: EqParam[] = [
  { p: "on" }, { p: "lowShelf" }, { p: "highShelf" }, { p: "hpfOn" }, { p: "hpfFreq" },
  ...Array.from({ length: EQ_BANDS }, (_, band) => [{ p: "freq", band }, { p: "gain", band }, { p: "q", band }] as EqParam[]).flat(),
];

/** Whether a channel type has a separate HPF in the given schema. */
export const hasHpf = (k: Kind, s: EqSchema) => (s.kind === "ql" ? k === "input" || k === "stereoInput" : true);

// ------------------------------------------------ QL (SysEx) addressing

export const QL_ELEMENTS = {
  inputEQ: 67, inputHPF: 66, mixEQ: 90, matrixEQ: 107, stereoEQ: 121,
} as const;

/** Writable (element → indices) in the QL protocol – everything else is rejected by the server. */
export const QL_WRITABLE: Record<number, number[]> = {
  67: [2, 3, 4, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22],
  90: [2, 3, 4, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22],
  107: [2, 3, 4, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22],
  121: [2, 3, 4, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22],
  66: [0, 1],
};

export function qlChannels(c: ChannelId, s: EqSchema): number[] {
  switch (c.kind) {
    case "input": return [c.index];
    case "stereoInput": { const base = s.inputCount ?? 64; return [base + c.index * 2, base + c.index * 2 + 1]; }
    case "mix": case "matrix": return [c.index];
    case "stereo": return [0, 1];
    case "mono": return [2];
    default: return [];
  }
}

function qlElement(c: ChannelId, e: EqParam): number {
  const hpf = e.p === "hpfOn" || e.p === "hpfFreq";
  switch (c.kind) {
    case "input": case "stereoInput": return hpf ? QL_ELEMENTS.inputHPF : QL_ELEMENTS.inputEQ;
    case "mix": return QL_ELEMENTS.mixEQ;
    case "matrix": return QL_ELEMENTS.matrixEQ;
    default: return QL_ELEMENTS.stereoEQ;
  }
}

function qlIndex(e: EqParam): number {
  switch (e.p) {
    case "on": return 2;
    case "lowShelf": return 3;
    case "highShelf": return 4;
    case "hpfOn": return 0;
    case "hpfFreq": return 1;
    case "q": return 8 + e.band * 4;
    case "freq": return 9 + e.band * 4;
    case "gain": return 10 + e.band * 4;
  }
}

/** QL key format: "QL:<element>:<index> <channel> 0". */
export const qlKey = (elem: number, index: number, ch: number): Key => `QL:${elem}:${index} ${ch} 0`;
export function parseQlKey(k: Key): { elem: number; index: number; ch: number } | null {
  const m = /^QL:(\d+):(\d+) (\d+) 0$/.exec(k);
  return m ? { elem: Number(m[1]), index: Number(m[2]), ch: Number(m[3]) } : null;
}

// ------------------------------------------------ generic API

export function eqAddress(c: ChannelId, e: EqParam, s: EqSchema): string {
  if (s.kind === "ql") return `QL:${qlElement(c, e)}:${qlIndex(e)}`;
  const seg = KIND_INFO[c.kind].segment;
  switch (e.p) {
    case "on": return `${PREFIX}${seg}/${s.segment}/On`;
    case "lowShelf": return `${PREFIX}${seg}/${s.segment}/LowShelving/On`;
    case "highShelf": return `${PREFIX}${seg}/${s.segment}/HighShelving/On`;
    case "freq": return `${PREFIX}${seg}/${s.segment}/Band/Freq`;
    case "gain": return `${PREFIX}${seg}/${s.segment}/Band/Gain`;
    case "q": return `${PREFIX}${seg}/${s.segment}/Band/Q`;
    case "hpfOn": return `${PREFIX}${seg}/HPF/On`;
    case "hpfFreq": return `${PREFIX}${seg}/HPF/Freq`;
  }
}

const eqY = (e: EqParam) => ("band" in e ? e.band : 0);

export function eqKey(c: ChannelId, e: EqParam, s: EqSchema): Key {
  if (s.kind === "ql") return qlKey(qlElement(c, e), qlIndex(e), qlChannels(c, s)[0]);
  return key(eqAddress(c, e, s), wireIndices(c)[0], eqY(e));
}

export function eqWriteKeys(c: ChannelId, e: EqParam, s: EqSchema): Key[] {
  if (s.kind === "ql") return qlChannels(c, s).map((ch) => qlKey(qlElement(c, e), qlIndex(e), ch));
  return wireIndices(c).map((x) => key(eqAddress(c, e, s), x, eqY(e)));
}

/** All EQ parameters that exist for a channel in this schema. */
export function eqParamsFor(c: ChannelId, s: EqSchema): EqParam[] {
  return EQ_PARAMS.filter((e) => (e.p === "hpfOn" || e.p === "hpfFreq" ? hasHpf(c.kind, s) : true));
}

export interface EqBand { freq: number; gain: number; q: number }
export interface EqSettings {
  on: boolean;
  lowShelf: boolean;
  highShelf: boolean;
  /** HIGH band set to low-pass on the console (QL type 2). */
  highLpf?: boolean;
  hpfOn: boolean;
  hpfFreq: number;
  bands: EqBand[];
}

export const EQ_RANGE = { freq: [20, 20000], gain: [-18, 18], q: [0.1, 16], hpf: [20, 600] } as const;

export function defaultEq(): EqSettings {
  return {
    on: true, lowShelf: false, highShelf: false, hpfOn: false, hpfFreq: 80,
    bands: [125, 1000, 4000, 10000].map((freq) => ({ freq, gain: 0, q: 0.7 })),
  };
}

/** Raw wire value for an EQ parameter. */
export function eqRaw(eq: EqSettings, e: EqParam, s: EqSchema): number {
  if (s.kind === "ql") {
    switch (e.p) {
      case "on": return eq.on ? 1 : 0;
      case "lowShelf": return eq.lowShelf ? 1 : 0;
      case "highShelf": return eq.highShelf ? 1 : 0;
      case "hpfOn": return eq.hpfOn ? 1 : 0;
      case "hpfFreq": return nearestIndex(QL_FREQ, eq.hpfFreq, QL_HPF_MIN, QL_HPF_MAX);
      case "freq": return nearestIndex(QL_FREQ, eq.bands[e.band].freq, 4);
      case "gain": return Math.max(-180, Math.min(180, Math.round(eq.bands[e.band].gain * 10)));
      case "q": return nearestIndex(QL_Q, eq.bands[e.band].q);
    }
  }
  switch (e.p) {
    case "on": return eq.on ? 1 : 0;
    case "lowShelf": return eq.lowShelf ? 1 : 0;
    case "highShelf": return eq.highShelf ? 1 : 0;
    case "hpfOn": return eq.hpfOn ? 1 : 0;
    case "hpfFreq": return Math.round(eq.hpfFreq * s.freqScale);
    case "freq": return Math.round(eq.bands[e.band].freq * s.freqScale);
    case "gain": return Math.round(eq.bands[e.band].gain * s.gainScale);
    case "q": return Math.round(eq.bands[e.band].q * s.qScale);
  }
}

/** Builds EqSettings from cached values. */
export function readEq(get: (k: Key) => Value | undefined, c: ChannelId, s: EqSchema): EqSettings {
  const eq = defaultEq();
  const num = (e: EqParam) => {
    const v = get(eqKey(c, e, s));
    return typeof v === "number" ? v : undefined;
  };
  const b = (e: EqParam, d: boolean) => { const v = num(e); return v === undefined ? d : v !== 0; };
  eq.on = b({ p: "on" }, true);
  if (s.kind === "ql") {
    eq.lowShelf = num({ p: "lowShelf" }) === 1;
    const high = num({ p: "highShelf" });
    eq.highShelf = high === 1;
    eq.highLpf = high === 2;
    eq.hpfOn = b({ p: "hpfOn" }, false);
    const hf = num({ p: "hpfFreq" });
    eq.hpfFreq = hf !== undefined ? QL_FREQ[Math.min(Math.max(hf, 0), QL_FREQ.length - 1)] : 80;
    for (let band = 0; band < EQ_BANDS; band++) {
      const f = num({ p: "freq", band }), g = num({ p: "gain", band }), q = num({ p: "q", band });
      if (f !== undefined) eq.bands[band].freq = QL_FREQ[Math.min(Math.max(f, 0), QL_FREQ.length - 1)];
      if (g !== undefined) eq.bands[band].gain = g / 10;
      if (q !== undefined) eq.bands[band].q = QL_Q[Math.min(Math.max(q, 0), QL_Q.length - 1)];
    }
    return eq;
  }
  eq.lowShelf = b({ p: "lowShelf" }, false);
  eq.highShelf = b({ p: "highShelf" }, false);
  eq.hpfOn = b({ p: "hpfOn" }, false);
  eq.hpfFreq = (num({ p: "hpfFreq" }) ?? 800) / s.freqScale;
  for (let band = 0; band < EQ_BANDS; band++) {
    const f = num({ p: "freq", band }), g = num({ p: "gain", band }), q = num({ p: "q", band });
    if (f !== undefined) eq.bands[band].freq = f / s.freqScale;
    if (g !== undefined) eq.bands[band].gain = g / s.gainScale;
    if (q !== undefined) eq.bands[band].q = q / s.qScale;
  }
  return eq;
}

/** Snaps settings to the console's resolution (so the UI shows what the console will use). */
export function snapEq(eq: EqSettings, s: EqSchema): EqSettings {
  if (s.kind !== "ql") return eq;
  return {
    ...eq,
    hpfFreq: QL_FREQ[nearestIndex(QL_FREQ, eq.hpfFreq, QL_HPF_MIN, QL_HPF_MAX)],
    bands: eq.bands.map((b) => ({
      freq: QL_FREQ[nearestIndex(QL_FREQ, b.freq, 4)],
      gain: Math.round(b.gain * 10) / 10,
      q: QL_Q[nearestIndex(QL_Q, b.q)],
    })),
  };
}

type Shape = "bell" | "lowShelf" | "highShelf" | "lowPass";

export function bandShape(eq: EqSettings, band: number): Shape {
  if (band === 0 && eq.lowShelf) return "lowShelf";
  if (band === EQ_BANDS - 1 && eq.highLpf) return "lowPass";
  if (band === EQ_BANDS - 1 && eq.highShelf) return "highShelf";
  return "bell";
}

interface BQ { b0: number; b1: number; b2: number; a1: number; a2: number }

function biquad(shape: Shape, f: number, gain: number, q: number, fs: number): BQ {
  const A = Math.pow(10, gain / 40);
  const w0 = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(q, 0.05));
  let b0, b1, b2, a0, a1, a2;
  if (shape === "lowPass") {
    const al = sw / (2 * 0.7071);
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (shape === "bell") {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else {
    const s = 2 * Math.sqrt(A) * alpha;
    if (shape === "lowShelf") {
      b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highPass(f: number, fs: number): BQ {
  const w0 = (2 * Math.PI * f) / fs, cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * 0.7071);
  const a0 = 1 + alpha;
  return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function magDb(q: BQ, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = q.b0 + q.b1 * c1 + q.b2 * c2, ni = -(q.b1 * s1 + q.b2 * s2);
  const dr = 1 + q.a1 * c1 + q.a2 * c2, di = -(q.a1 * s1 + q.a2 * s2);
  return 10 * Math.log10(Math.max((nr * nr + ni * ni) / Math.max(dr * dr + di * di, 1e-30), 1e-30));
}

export function eqResponse(eq: EqSettings, f: number, fs = 48000): number {
  let total = 0;
  if (eq.on) {
    eq.bands.forEach((b, i) => {
      const shape = bandShape(eq, i);
      if (shape === "lowPass" || Math.abs(b.gain) >= 0.01) total += magDb(biquad(shape, b.freq, b.gain, b.q, fs), f, fs);
    });
  }
  if (eq.hpfOn) total += magDb(highPass(eq.hpfFreq, fs), f, fs);
  return total;
}

export function bandResponse(eq: EqSettings, band: number, f: number, fs = 48000): number {
  const b = eq.bands[band];
  return magDb(biquad(bandShape(eq, band), b.freq, b.gain, b.q, fs), f, fs);
}

export function freqText(hz: number): string {
  if (hz >= 1000) return hz >= 10000 ? `${(hz / 1000).toFixed(1)}k` : `${(hz / 1000).toFixed(2)}k`;
  return hz >= 100 ? hz.toFixed(0) : hz.toFixed(1);
}

export const gainDbText = (db: number) => {
  const v = Math.round(db * 10) / 10 + 0;
  return (v > 0 ? "+" : "") + v.toFixed(1);
};

export const qText = (q: number) => (q >= 10 ? q.toFixed(1) : q >= 1 ? q.toFixed(2).replace(/0$/, "") : q.toFixed(2));

// ---------------------------------------------------------------- QL SysEx (editor protocol)

/** Encodes a parameter change (value given) or request (value omitted). Device number 0. */
export function qlSysex(elem: number, index: number, ch: number, value?: number): number[] {
  const b = [0xf0, 0x43, value === undefined ? 0x30 : 0x10, 0x3e, 0x19, 0x01,
    (elem >> 7) & 0x7f, elem & 0x7f, (index >> 7) & 0x7f, index & 0x7f, (ch >> 7) & 0x7f, ch & 0x7f];
  if (value !== undefined) {
    const u = value >>> 0;
    b.push((u >>> 28) & 0x0f, (u >>> 21) & 0x7f, (u >>> 14) & 0x7f, (u >>> 7) & 0x7f, u & 0x7f);
  }
  b.push(0xf7);
  return b;
}

/** Decodes an 18-byte parameter change message. */
export function qlParseChange(m: Uint8Array): { elem: number; index: number; ch: number; value: number } | null {
  if (m.length !== 18 || m[0] !== 0xf0 || m[1] !== 0x43 || (m[2] & 0xf0) !== 0x10 || m[3] !== 0x3e || m[5] !== 0x01) return null;
  const value = (((m[12] & 0x0f) << 28) | (m[13] << 21) | (m[14] << 14) | (m[15] << 7) | m[16]) | 0;
  return { elem: (m[6] << 7) | m[7], index: (m[8] << 7) | m[9], ch: (m[10] << 7) | m[11], value };
}
