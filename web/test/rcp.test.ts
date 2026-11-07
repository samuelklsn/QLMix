import { test } from "node:test";
import assert from "node:assert/strict";
import * as r from "../shared/rcp.ts";

test("tokenizer handles quotes and escapes", () => {
  assert.deepEqual(r.tokenize('OK get A 0 0 "Lead Vox"').map((t) => t.text), ["OK", "get", "A", "0", "0", "Lead Vox"]);
  assert.deepEqual(r.tokenize('set A 0 0 "a\\"b" ""').map((t) => t.text), ["set", "A", "0", "0", 'a"b', ""]);
  assert.equal(r.quote('x"y\\'), '"x\\"y\\\\"');
});

test("parses parameters, scenes, meters, errors", () => {
  assert.deepEqual(r.parseLine('NOTIFY set MIXER:Current/InCh/Fader/Level 3 0 -1000 "-10.00"'), {
    kind: "param", status: "NOTIFY", command: "set", address: "MIXER:Current/InCh/Fader/Level", x: 3, y: 0, value: -1000,
  });
  const name = r.parseLine('OK get MIXER:Current/InCh/Label/Name 0 0 "123"');
  assert.equal(name.kind === "param" && name.value, "123");
  assert.deepEqual(r.parseLine("NOTIFY sscurrent_ex MIXER:Lib/Scene 12"), { kind: "scene", status: "NOTIFY", command: "sscurrent_ex", number: 12 });
  assert.deepEqual(r.parseLine("NOTIFY mtr MIXER:Current/Mix/PostOn PostOn 7e 00 1f"), { kind: "meter", address: "MIXER:Current/Mix/PostOn", values: [126, 0, 31] });
  assert.deepEqual(r.parseLine("ERROR get UnknownAddress"), { kind: "error", command: "get", reason: "UnknownAddress" });
  assert.deepEqual(r.parseLine('OK devinfo productname "QL5"'), { kind: "info", status: "OK", command: "devinfo", args: ["productname", "QL5"] });
});

test("commands and keys", () => {
  assert.equal(r.cmd.set("MIXER:Current/InCh/Label/Name", 4, 0, "Vox"), 'set MIXER:Current/InCh/Label/Name 4 0 "Vox"');
  const st = r.channelId("stereoInput", 2);
  assert.deepEqual(r.channelWriteKeys(st, "on"), ["MIXER:Current/StInCh/Fader/On 4 0", "MIXER:Current/StInCh/Fader/On 5 0"]);
  assert.equal(r.channelParamKey(r.channelId("mono", 0), "level"), "MIXER:Current/St/Fader/Level 2 0");
  assert.equal(r.sendKey(r.channelId("input", 7), 3, "level"), "MIXER:Current/InCh/ToMix/Level 7 3");
  assert.equal(r.channelParamKey(r.channelId("input", 0), "gain"), "MIXER:Current/InCh/Port/HA/Gain 0 0");
  assert.equal(r.channelParamKey(r.channelId("input", 0), "cue"), "MIXER:Current/Cue/InCh/On 0 0");
});

test("levels and fader law", () => {
  assert.equal(r.levelText(r.NEG_INF), "-∞");
  assert.equal(r.levelText(0), "0.0");
  assert.equal(r.levelText(350), "+3.5");
  assert.equal(r.levelText(-4), "0.0");
  assert.equal(r.positionToLevel(0), r.NEG_INF);
  assert.equal(r.positionToLevel(1), 1000);
  for (let db = -40; db <= 10; db += 0.5) {
    const raw = Math.round(db * 100);
    assert.ok(Math.abs(r.positionToLevel(r.levelToPosition(raw)) - raw) <= 10, `round trip ${db}`);
  }
  let last = -1;
  for (let raw = -13800; raw <= 1000; raw += 25) {
    const p = r.levelToPosition(raw);
    assert.ok(p >= last);
    last = p;
  }
});

test("models and colors", () => {
  assert.equal(r.modelFromProductName("QL1").counts.input, 32);
  assert.equal(r.modelFromProductName("?").name, "QL5");
  assert.equal(r.normalizeColor("SkyBlue"), "Cyan");
  assert.equal(r.normalizeColor(undefined), "Off");
  assert.equal(r.meterKind("MIXER:Current/Meter/Mtrx/PostOn"), "matrix");
  assert.equal(r.meterNorm(126), 1);
});

test("eq addressing and response", () => {
  const s = r.EQ_SCHEMAS[0];
  const c = r.channelId("input", 4);
  assert.equal(r.eqKey(c, { p: "gain", band: 2 }, s), "MIXER:Current/InCh/PEQ/Band/Gain 4 2");
  assert.equal(r.eqKey(c, { p: "hpfFreq" }, s), "MIXER:Current/InCh/HPF/Freq 4 0");
  assert.equal(r.EQ_PARAMS.length, 17);

  const values = new Map<string, r.Value>([
    [r.eqKey(c, { p: "gain", band: 1 }, s), -450],
    [r.eqKey(c, { p: "freq", band: 1 }, s), 25000],
    [r.eqKey(c, { p: "hpfOn" }, s), 1],
  ]);
  const eq = r.readEq((k) => values.get(k), c, s);
  assert.deepEqual(eq.bands[1], { freq: 2500, gain: -4.5, q: 0.7 });
  assert.equal(eq.hpfOn, true);
  assert.equal(r.eqRaw(eq, { p: "gain", band: 1 }, s), -450);

  const flat = r.defaultEq();
  assert.ok(Math.abs(r.eqResponse(flat, 1000)) < 1e-6);
  flat.bands[1] = { freq: 1000, gain: 6, q: 1 };
  assert.ok(Math.abs(r.eqResponse(flat, 1000) - 6) < 0.05);
  const hp = r.defaultEq();
  hp.hpfOn = true; hp.hpfFreq = 100;
  assert.ok(Math.abs(r.eqResponse(hp, 100) + 3) < 0.2);
});

test("QL editor protocol (SysEx)", () => {
  // captured from QL Editor: CH 64 LOW gain -5 (= -0.5 dB)
  const captured = Uint8Array.from(Buffer.from("f043103e19010043000a003f0f7f7f7f7bf7", "hex"));
  assert.deepEqual(r.qlParseChange(captured), { elem: 67, index: 10, ch: 63, value: -5 });
  assert.deepEqual(r.qlSysex(67, 10, 63, -5), [...captured]);
  assert.deepEqual(r.qlSysex(67, 10, 63), [0xf0, 0x43, 0x30, 0x3e, 0x19, 0x01, 0, 67, 0, 10, 0, 63, 0xf7]);
  assert.deepEqual(r.qlSysex(862, 1, 63, 36).slice(6, 12), [6, 94, 0, 1, 0, 63]);

  const s = { ...r.QL_SCHEMA, inputCount: 64 };
  const ch = r.channelId("input", 63);
  assert.equal(r.eqKey(ch, { p: "gain", band: 1 }, s), "QL:67:14 63 0");
  assert.equal(r.eqKey(ch, { p: "hpfFreq" }, s), "QL:66:1 63 0");
  assert.deepEqual(r.eqWriteKeys(r.channelId("stereoInput", 1), { p: "on" }, s), ["QL:67:2 66 0", "QL:67:2 67 0"]);
  assert.equal(r.eqKey(r.channelId("mono", 0), { p: "q", band: 3 }, s), "QL:121:20 2 0");
  assert.deepEqual(r.parseQlKey("QL:67:14 63 0"), { elem: 67, index: 14, ch: 63 });

  // factory defaults read from a QL5: LOW 125 Hz shelf, 1k/4k/10k, HPF 80 Hz
  const defaults = new Map<string, r.Value>([
    ["QL:67:3 63 0", 1], ["QL:67:4 63 0", 1], ["QL:67:9 63 0", 36], ["QL:67:13 63 0", 72], ["QL:67:17 63 0", 96],
    ["QL:67:21 63 0", 112], ["QL:66:1 63 0", 28], ["QL:67:8 63 0", 23], ["QL:67:10 63 0", -160],
  ]);
  const eq = r.readEq((k) => defaults.get(k), ch, s);
  assert.deepEqual(eq.bands.map((b) => b.freq), [125, 1000, 4000, 10000]);
  assert.equal(eq.hpfFreq, 80);
  assert.equal(eq.lowShelf, true);
  assert.equal(eq.highShelf, true);
  assert.equal(eq.bands[0].gain, -16);
  assert.equal(r.eqRaw(eq, { p: "freq", band: 0 }, s), 36);
  assert.equal(r.eqRaw(eq, { p: "q", band: 0 }, s), 23);
  assert.equal(r.eqRaw(eq, { p: "hpfFreq" }, s), 28);
  assert.equal(r.QL_FREQ.length, 125);
  assert.equal(r.QL_Q.length, 45);
});

test("QL dynamics and premium rack keys", async () => {
  const q = await import("../shared/ql-params.ts");
  const s = { ...r.QL_SCHEMA, inputCount: 64 };
  const ch1 = r.channelId("input", 0);
  assert.equal(q.dynaKey(ch1, 1, "threshold", s), "QL:64:16 0 0");
  assert.equal(q.dynaKey(r.channelId("mix", 2), 0, "ratio", s), "QL:88:13 2 0");
  assert.equal(q.dynaKey(r.channelId("mix", 2), 1, "ratio", s), null, "outputs have one dynamics section");
  assert.deepEqual(q.dynaWriteKeys(r.channelId("stereoInput", 0), 0, "on", s), ["QL:61:0 64 0", "QL:61:0 65 0"]);
  assert.equal(q.allDynaKeys(ch1, s).length, 34);
  assert.equal(q.DYNA_CONTROLS.ratio!.text(5), "2.0:1");
  assert.equal(q.DYNA_CONTROLS.ratio!.text(15), "∞:1");
  assert.equal(q.DYNA_CONTROLS.threshold!.text(-180), "-18.0 dB");

  assert.equal(q.rackKey(3, 4), "QL:705:4 3 0");
  assert.equal(q.rackParamIndex("A", 1), 6);
  assert.equal(q.rackParamIndex("B", 1), 74);
  assert.equal(q.allRackKeys(0).length, 143);
  const packed = [0x506f7274, 0x69636f35, 0x30343300, 0]; // "Portico5043"
  assert.equal(q.decodeRackName(packed), "Portico5043");
  assert.equal(q.decodeRackName([0, 0, 0, 0]), null);
  const w = q.extraWritable();
  assert.ok(w[64].includes(16) && !w[705].includes(0), "rack names are read-only");
});
