import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoLevel, decodeInputMeters } from "../server/autolevel.ts";
import type { ChannelId } from "../shared/rcp.ts";

/** Simulated church: room level = voice + fader + room gain while the speaker talks. */
function room(opts: { voice: number; faders: Record<string, number> }) {
  let now = 0;
  const on: Record<string, boolean> = { "input:0": true, "input:1": false };
  const io = {
    now: () => now,
    fader: (c: ChannelId) => opts.faders[`${c.kind}:${c.index}`],
    isOn: (c: ChannelId) => on[`${c.kind}:${c.index}`] ?? false,
    setFader: (c: ChannelId, raw: number) => { opts.faders[`${c.kind}:${c.index}`] = raw; },
    label: (c: ChannelId) => `CH ${c.index + 1}`,
  };
  const al = new AutoLevel(io, { channels: [{ kind: "input", index: 0 }, { kind: "input", index: 1 }] });
  /** Runs `seconds` of speech (alternating words and short pauses) and ticks the controller. */
  const run = (seconds: number, talking = true, feedback = false) => {
    for (let i = 0; i < seconds * 10; i++) {
      now += 100;
      const speakingNow = talking && i % 10 < 8;
      const level = speakingNow ? opts.voice + opts.faders["input:0"] / 100 - 30 + Math.sin(i) * 1.5 : -70 + Math.random();
      if (i % 2 === 0) al.addRoomSample(level, feedback);
      if (i % 2 === 1) al.tick();
    }
  };
  return { al, run, on, setNow: (t: number) => (now = t), get now() { return now; } };
}

test("takes the reference and keeps a quieter speaker at the target", () => {
  const faders = { "input:0": 0, "input:1": 0 };
  const sim = room({ voice: 0, faders });
  sim.run(25);                                 // normal speaker at 0 dB fader → room ≈ −30 dBFS
  assert.equal(sim.al.takeReference(), null);
  const ref = sim.al.config.reference!;
  assert.ok(Math.abs(ref + 30) < 2, `reference ${ref}`);
  assert.equal(sim.al.start(), null);

  // A quiet speaker (−4 dB) takes over → fader must rise by ≈ 4 dB, within the limits.
  (sim as any).al["room"] = [];
  const quiet = room({ voice: -4, faders });
  Object.assign(quiet.al, { config: sim.al.config });
  quiet.al.start();
  quiet.run(40);
  assert.ok(faders["input:0"] >= 250 && faders["input:0"] <= 600, `fader ${faders["input:0"]}`);
  const s = quiet.al.getStatus();
  assert.equal(s.active, "CH 1");
});

test("never exceeds the maximum boost", () => {
  const faders = { "input:0": 0, "input:1": 0 };
  const sim = room({ voice: -20, faders });
  sim.al.config.reference = -30;
  sim.al.config.maxBoost = 6;
  sim.al.start();
  sim.run(60);
  assert.equal(faders["input:0"], 500, "absolute ceiling (+5 dB) wins over maxBoost (+6 dB)");
  assert.match(sim.al.getStatus().message, /Grenze/);

  faders["input:0"] = -1000;
  const sim2 = room({ voice: -20, faders });
  Object.assign(sim2.al.config, { reference: -30, maxBoost: 6, ceiling: 10 });
  sim2.al.start();
  sim2.run(60);
  assert.equal(faders["input:0"], -400, "max. +6 dB above the starting position");
});

test("feedback cuts immediately and blocks raising", () => {
  const faders = { "input:0": 300, "input:1": 0 };
  const sim = room({ voice: -10, faders });
  sim.al.config.reference = -30;
  sim.al.start();
  sim.run(25);                                 // fills history
  const before = faders["input:0"];
  sim.run(1, true, true);
  assert.ok(faders["input:0"] <= before - 300, `cut ${before} → ${faders["input:0"]}`);
  assert.match(sim.al.getStatus().message, /Rückkopplung/);
});

test("holds when the phone stops measuring and pauses after a manual move", () => {
  const faders = { "input:0": 0, "input:1": 0 };
  const sim = room({ voice: -5, faders });
  sim.al.config.reference = -30;
  sim.al.start();
  sim.run(20);
  const pos = faders["input:0"];
  sim.setNow(sim.now + 5000);                  // no samples for 5 s
  sim.al.tick();
  assert.match(sim.al.getStatus().message, /Keine Messung/);
  assert.equal(faders["input:0"], pos);

  sim.run(3);
  faders["input:0"] = -1000;                   // somebody pulls the fader by hand
  sim.run(2);
  assert.equal(faders["input:0"], -1000);
  assert.match(sim.al.getStatus().message, /von Hand/);
});

test("needs channels and a reference before starting", () => {
  const sim = room({ voice: 0, faders: { "input:0": 0 } });
  sim.al.config.channels = [];
  assert.match(sim.al.start()!, /Mikrofone/);
  sim.al.config.channels = [{ kind: "input", index: 0 }];
  assert.match(sim.al.start()!, /So soll es klingen/);
});

test("decodes the input meter block (88 × 10)", () => {
  const data = new Uint8Array(880);
  data[0 * 10 + 1] = 77;            // CH 1 pre-EQ
  data[72 * 10 + 1] = 40;           // ST IN 1 L
  data[73 * 10 + 1] = 55;           // ST IN 1 R
  const m = Uint8Array.from([0xf0, 0x43, 0x10, 0x3e, 0x19, 0x21, 0x00, 0x7f, 0x00, ...data, 0xf7]);
  const levels = decodeInputMeters(m)!;
  assert.equal(levels.get("input:0"), 77);
  assert.equal(levels.get("stereoInput:0"), 55);
  assert.equal(decodeInputMeters(m.subarray(0, 100)), null);
});

test("detects the pulpit mic by its own noise floor, and explains a closed fader", () => {
  let now = 0;
  const faders: Record<string, number> = { "input:0": -500, "input:1": 0 };
  const io = {
    now: () => now,
    fader: (c: ChannelId) => faders[`${c.kind}:${c.index}`],
    isOn: () => true,
    setFader: (c: ChannelId, raw: number) => { faders[`${c.kind}:${c.index}`] = raw; },
    label: (c: ChannelId) => (c.index === 0 ? "Kanzel" : "Links"),
  };
  const al = new AutoLevel(io, { channels: [{ kind: "input", index: 0 }, { kind: "input", index: 1 }], reference: -30 });
  al.start();
  // 10 s of quiet: Kanzel has a high noise floor (gain +45 dB), "Links" a low one.
  for (let i = 0; i < 100; i++) {
    now += 100;
    al.setMeters(new Map([["input:0", 50 + (i % 3)], ["input:1", 20 + (i % 3)]]));
    al.addRoomSample(-70, false);
  }
  // Someone talks near "Links": it is far above its own floor although Kanzel shows the higher raw value.
  for (let i = 0; i < 10; i++) {
    now += 100;
    al.setMeters(new Map([["input:0", 66], ["input:1", 58]]));
    al.addRoomSample(-30, false);
    al.tick();
  }
  let s = al.getStatus();
  assert.equal(s.active, "Links", "Links: 58 − 20 = 38 above its floor beats Kanzel 66 − 50 = 16");
  // Now someone talks into the pulpit.
  for (let i = 0; i < 10; i++) {
    now += 100;
    al.setMeters(new Map([["input:0", 75], ["input:1", 22]]));
    al.addRoomSample(-30, false);
    al.tick();
  }
  s = al.getStatus();
  assert.equal(s.active, "Kanzel");
  assert.equal(s.mics.find((m) => m.label === "Kanzel")?.speaking, true);

  faders["input:0"] = -32768;                    // pulpit fader closed
  al.tick();
  s = al.getStatus();
  assert.equal(s.active, "Kanzel");
  assert.match(s.message, /Kanzel spricht, aber Fader ist ganz unten/);
});
