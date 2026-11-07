// CL/QL editor-protocol parameters beyond EQ: channel dynamics and the Premium Rack.
//
// Element/parameter numbers come from QL Editor V5.8.1 (verified structure). The value
// encodings marked `calibrated: false` are educated guesses from the QL reference manual and
// still have to be checked against the console screen (see web/README.md → Kalibrierung).

import {
  type ChannelId, type EqSchema, type Key, type Kind,
  qlChannels, qlKey,
} from "./rcp.ts";

// ---------------------------------------------------------------- Dynamics

/** Dynamics elements per channel kind: [Dynamics 1, Dynamics 2]. Outputs only have one. */
export const QL_DYNA_ELEMENTS: Partial<Record<Kind, number[]>> = {
  input: [61, 64],
  stereoInput: [61, 64],
  mix: [88],
  matrix: [105],
  stereo: [119],
  mono: [119],
};

export const dynaSlots = (k: Kind): number => QL_DYNA_ELEMENTS[k]?.length ?? 0;

/** Parameter indices within a dynamics element (kInputDynamics1 … from QL Editor). */
export const DYNA = {
  on: 0, type: 1, auto: 2, leftSideChain: 3, keyIn: 4, filterOn: 5, filterType: 6, filterFreq: 7, filterQ: 8,
  attack: 9, range: 10, hold: 11, release: 12, ratio: 13, gain: 14, knee: 15, threshold: 16,
} as const;
export type DynaParam = keyof typeof DYNA;

export const DYNA_PARAM_COUNT = 17;

/** Processor types per section, in the order of the QL manual (index order still to be verified). */
export function dynaTypeNames(kind: Kind, slot: number): string[] {
  if (kind === "input" || kind === "stereoInput") {
    return slot === 0 ? ["GATE", "DUCKING", "COMPRESSOR", "EXPANDER"] : ["COMPRESSOR", "COMPANDER-H", "COMPANDER-S", "DE-ESSER"];
  }
  return ["COMPRESSOR", "EXPANDER", "COMPANDER-H", "COMPANDER-S"];
}

export type DynaFamily = "gate" | "comp" | "compander" | "deesser";
export function dynaFamily(typeName: string | undefined): DynaFamily {
  if (!typeName) return "comp";
  if (typeName === "GATE" || typeName === "DUCKING") return "gate";
  if (typeName.startsWith("COMPANDER")) return "compander";
  if (typeName === "DE-ESSER") return "deesser";
  return "comp";
}

export function dynaElement(c: ChannelId, slot: number): number | undefined {
  return QL_DYNA_ELEMENTS[c.kind]?.[slot];
}

export function dynaKey(c: ChannelId, slot: number, p: DynaParam, s: EqSchema): Key | null {
  const e = dynaElement(c, slot);
  return e === undefined ? null : qlKey(e, DYNA[p], qlChannels(c, s)[0]);
}

export function dynaWriteKeys(c: ChannelId, slot: number, p: DynaParam, s: EqSchema): Key[] {
  const e = dynaElement(c, slot);
  return e === undefined ? [] : qlChannels(c, s).map((ch) => qlKey(e, DYNA[p], ch));
}

export function allDynaKeys(c: ChannelId, s: EqSchema): Key[] {
  const out: Key[] = [];
  for (let slot = 0; slot < dynaSlots(c.kind); slot++) {
    for (const p of Object.keys(DYNA) as DynaParam[]) out.push(dynaKey(c, slot, p, s)!);
  }
  return out;
}

// ------------------------------------------------ value conversions

export const RATIO_TABLE = [1.0, 1.1, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10, 20, Infinity];

/** 160-step time tables (48 kHz) – logarithmic approximation of the manual's ranges. */
const logStep = (lo: number, hi: number, steps: number, i: number) => lo * Math.pow(hi / lo, Math.min(Math.max(i, 0), steps - 1) / (steps - 1));
export const holdMs = (i: number) => logStep(0.02, 1960, 160, i);
export const releaseMs = (i: number) => logStep(5, 42300, 160, i);

export function msText(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export interface DynaControl {
  param: DynaParam;
  label: string;
  min: number;
  max: number;
  /** raw → display text */
  text: (raw: number) => string;
  /** true once the encoding was checked against the console */
  calibrated: boolean;
}

const db1 = (raw: number) => `${(raw / 10).toFixed(1)} dB`;

export const DYNA_CONTROLS: Record<DynaParam, DynaControl | null> = {
  threshold: { param: "threshold", label: "Threshold", min: -720, max: 0, text: db1, calibrated: false },
  ratio: { param: "ratio", label: "Ratio", min: 0, max: 15, text: (r) => { const v = RATIO_TABLE[r]; return v === undefined ? `#${r}` : v === Infinity ? "∞:1" : `${v < 10 ? v.toFixed(1) : v}:1`; }, calibrated: false },
  attack: { param: "attack", label: "Attack", min: 0, max: 120, text: (r) => `${r} ms`, calibrated: false },
  release: { param: "release", label: "Release", min: 0, max: 159, text: (r) => msText(releaseMs(r)), calibrated: false },
  hold: { param: "hold", label: "Hold", min: 0, max: 159, text: (r) => msText(holdMs(r)), calibrated: false },
  range: { param: "range", label: "Range", min: -70, max: 0, text: (r) => (r <= -70 ? "-∞" : `${r} dB`), calibrated: false },
  gain: { param: "gain", label: "Out Gain", min: -180, max: 180, text: db1, calibrated: false },
  knee: { param: "knee", label: "Knee", min: 0, max: 5, text: (r) => (r === 0 ? "Hard" : String(r)), calibrated: false },
  on: null, type: null, auto: null, leftSideChain: null, keyIn: null, filterOn: null, filterType: null, filterFreq: null, filterQ: null,
};

/** Controls shown for each processor family. */
export const DYNA_LAYOUT: Record<DynaFamily, DynaParam[]> = {
  gate: ["threshold", "range", "attack", "hold", "release"],
  comp: ["threshold", "ratio", "attack", "release", "gain", "knee"],
  compander: ["threshold", "ratio", "attack", "release", "gain", "range"],
  deesser: ["threshold"],
};

/** Display label for the release slot (gate/ducking call it "Decay"). */
export const releaseLabel = (family: DynaFamily) => (family === "gate" ? "Decay" : "Release");

// ---------------------------------------------------------------- Premium Rack

/** kPremiumEffect – "channel" = rack 0…7; L = A side, R = B side of dual modules. */
export const QL_RACK_ELEMENT = 705;
/** kRackMount – mounted module type per rack ("channel" = rack). */
export const QL_RACK_MOUNT_ELEMENT = 132;
export const RACK_COUNT = 8;
export const RACK_NAME_PARAMS = [0, 1, 2, 3];
export const RACK_BYPASS = { A: 4, B: 5 } as const;
export const RACK_PARAMS_PER_SIDE = 68;
export const RACK_PARAM_COUNT = 6 + 2 * RACK_PARAMS_PER_SIDE; // 142

/** Index of module parameter n (1-based) on side A or B. */
export const rackParamIndex = (side: "A" | "B", n: number) => (side === "A" ? 6 : 6 + RACK_PARAMS_PER_SIDE) + (n - 1);

export const rackKey = (rack: number, index: number): Key => qlKey(QL_RACK_ELEMENT, index, rack);
export const rackMountKey = (rack: number): Key => qlKey(QL_RACK_MOUNT_ELEMENT, 0, rack);

export function allRackKeys(rack: number): Key[] {
  return [rackMountKey(rack), ...Array.from({ length: RACK_PARAM_COUNT }, (_, i) => rackKey(rack, i))];
}

/**
 * Decodes the module name from the four name parameters. The exact packing is not yet known;
 * this tries 4 ASCII characters per 32-bit value (big- and little-endian) and returns the most
 * plausible result, or null.
 */
export function decodeRackName(values: (number | undefined)[]): string | null {
  if (values.some((v) => v === undefined)) return null;
  const tryOrder = (be: boolean) => {
    let s = "";
    for (const v of values as number[]) {
      const u = v >>> 0;
      const bytes = [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
      for (const b of be ? bytes : bytes.reverse()) if (b !== 0) s += String.fromCharCode(b);
    }
    return s.trim();
  };
  for (const s of [tryOrder(true), tryOrder(false)]) {
    if (s.length >= 2 && /^[\x20-\x7e]+$/.test(s)) return s;
  }
  return null;
}

/** Module knob layouts – filled in during calibration at the console. */
export interface RackControl {
  label: string;
  /** 1-based parameter number on the module side */
  param: number;
  min: number;
  max: number;
  text?: (raw: number) => string;
}
export const RACK_MODULES: Record<string, RackControl[]> = {
  // "Portico5043": [ { label: "Threshold", param: ?, … }, … ]  ← nach Kalibrierung
  // "DynamicEQ":  [ … ]
};

/** Writable elements/indices (merged into the server whitelist). */
export function extraWritable(): Record<number, number[]> {
  const dyna = Array.from({ length: DYNA_PARAM_COUNT }, (_, i) => i);
  const rack = Array.from({ length: RACK_PARAM_COUNT - 4 }, (_, i) => i + 4); // not the name fields
  return { 61: dyna, 64: dyna, 88: dyna, 105: dyna, 119: dyna, [QL_RACK_ELEMENT]: rack };
}
