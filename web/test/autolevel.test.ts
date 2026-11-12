import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoLevel, decodeInputMeters } from "../server/autolevel.ts";
import type { ChannelId } from "../shared/rcp.ts";

const NEG_INF = -32768;
const key = (c: ChannelId) => `${c.kind}:${c.index}`;

/**
 * Simulated church with two speaker mics: CH 1 "Kanzel" and CH 2 "Pult", and a room mic on CH 3.
 * Console meters (pre-EQ, before ON/fader) show who talks; the room mic hears
 * voice + fader of the talking mic, but only if that channel is ON.
 */
function church(start: { faders?: Record<string, number>; on?: Record<string, boolean> } = {}) {
  let now = 0;
  const faders: Record<string, number> = { "input:0": NEG_INF, "input:1": NEG_INF, ...start.faders };
  const on: Record<string, boolean> = { "input:0": false, "input:1": false, ...start.on };
  const io = {
    now: () => now,
    fader: (c: ChannelId) => faders[key(c)],
    isOn: (c: ChannelId) => on[key(c)] ?? false,
    setFader: (c: ChannelId, raw: number) => { faders[key(c)] = raw; },
    setOn: (c: ChannelId, v: boolean) => { on[key(c)] = v; },
    label: (c: ChannelId) => (c.index === 0 ? "Kanzel" : "Pult"),
  };
  const al = new AutoLevel(io, {
    channels: [{ kind: "input", index: 0 }, { kind: "input", index: 1 }], roomMics: [{ kind: "input", index: 2 }], reference: -30,
  });
  /** Who talks (mic key) and how loud the voice is (dB, 0 = normal speaker). */
  let talker: string | null = null;
  let voice = 0;
  let feedback = false;
  /** Runs `seconds` in 100 ms steps: meters (incl. room mic) every step, controller every 2nd. */
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      now += 100;
      const word = i % 10 < 8; // words with short pauses
      const meters = new Map<string, number>();
      for (const k of ["input:0", "input:1"]) {
        const noise = (k === "input:0" ? 50 : 20) + (i % 3);   // Kanzel has much more gain
        meters.set(k, talker === k && word ? noise + 30 + voice : talker && word ? noise + 4 : noise);
      }
      const audible = talker !== null && word && on[talker] && faders[talker] > NEG_INF;
      const roomDb = feedback ? -10 : audible ? voice + faders[talker!] / 100 - 30 + Math.sin(i) : -70 + Math.random();
      meters.set("input:2", Math.round(roomDb + 126));
      al.setMeters(meters);
      if (i % 2 === 1) al.tick();
    }
  };
  return {
    al, faders, on, run,
    talk: (k: string | null, v = 0) => { talker = k; voice = v; },
    setFeedback: (v: boolean) => { feedback = v; },
    skip: (ms: number) => { now += ms; },
  };
}

test("switches a closed mic on, pulls the fader up and regulates to the target", () => {
  const sim = church();
  assert.equal(sim.al.start(), null);
  sim.run(25);                                   // quiet: noise floors are learned
  assert.equal(sim.on["input:0"], false);

  sim.talk("input:0", -6);                       // a quiet speaker at the pulpit
  sim.run(1);
  assert.equal(sim.on["input:0"], true, "Kanzel switched on");
  assert.equal(sim.faders["input:0"], -1000, "jumps to the start level (−10 dB)");
  assert.match(sim.al.getStatus().event ?? "", /Kanzel spricht – Fader auf −10 dB, eingeschaltet/);
  assert.equal(sim.on["input:1"], false, "the other mic stays off");

  sim.run(30);
  // room = voice + fader − 30 → target −30 needs fader ≈ +6 dB, but the ceiling is +5 dB
  assert.equal(sim.faders["input:0"], 500);
  sim.al.config.ceiling = 10;
  sim.run(15);
  assert.ok(Math.abs(sim.faders["input:0"] - 600) <= 150, `fader ${sim.faders["input:0"]}`);
  assert.equal(sim.al.getStatus().active, "Kanzel");
  assert.ok(sim.al.config.learned["input:0"] !== undefined, "position remembered");
});

test("closes a mic it opened after the silence and restores the old state", () => {
  const sim = church({ faders: { "input:1": -2000 } });
  sim.al.config.closeAfter = 30;
  sim.al.start();
  sim.run(25);
  sim.talk("input:1");
  sim.run(10);
  assert.equal(sim.on["input:1"], true);
  sim.talk(null);
  sim.run(20);
  assert.equal(sim.on["input:1"], true, "short pauses keep it open");
  const pult = sim.al.getStatus().mics.find((m) => m.label === "Pult")!;
  assert.ok(pult.opened && pult.closesIn !== null && pult.closesIn <= 10, `closesIn ${pult.closesIn}`);
  sim.run(12);
  assert.equal(sim.on["input:1"], false, "switched off again");
  assert.equal(sim.faders["input:1"], -2000, "fader back where it was");
  assert.match(sim.al.getStatus().event ?? "", /Pult: 30 s still – wieder geschlossen/);
});

test("uses the learned position next time", () => {
  const sim = church();
  sim.al.config.learned["input:0"] = -350;
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  sim.run(1);
  assert.equal(sim.faders["input:0"], -350);
  assert.match(sim.al.getStatus().event ?? "", /gemerkt/);
});

test("does not open a mic that only overhears another speaker", () => {
  const sim = church({ faders: { "input:0": 0 }, on: { "input:0": true } });
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");                            // pulpit talks; Pult hears it 4 dB above its floor
  sim.run(20);
  assert.equal(sim.on["input:1"], false);
  assert.equal(sim.al.getStatus().active, "Kanzel");
});

test("does not leave a mic open the automatic did not open", () => {
  const sim = church({ faders: { "input:0": -500 }, on: { "input:0": true } });
  sim.al.config.closeAfter = 15;
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  sim.run(5);
  sim.talk(null);
  sim.run(40);
  assert.equal(sim.on["input:0"], true);
  assert.ok(sim.faders["input:0"] > NEG_INF);
});

test("a mic switched off by hand while talking stays off until it was quiet", () => {
  const sim = church();
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  sim.run(2);
  assert.equal(sim.on["input:0"], true);
  sim.on["input:0"] = false;                      // the technician mutes it
  sim.run(5);
  assert.equal(sim.on["input:0"], false);
  assert.equal(sim.al.getStatus().mics[0].blocked, true);
  sim.talk(null);
  sim.run(12);
  sim.talk("input:0");
  sim.run(2);
  assert.equal(sim.on["input:0"], true, "opens again after 10 s of quiet");
});

test("a manual fader move pauses the channel and is remembered", () => {
  const sim = church({ faders: { "input:0": 0 }, on: { "input:0": true } });
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  sim.run(5);
  sim.faders["input:0"] = -800;                    // pulled down a bit by hand
  sim.run(3);
  assert.equal(sim.faders["input:0"], -800);
  assert.match(sim.al.getStatus().message, /von Hand/);
  assert.equal(sim.al.config.learned["input:0"], -800);
});

test("console rounding is not taken for a manual move", () => {
  const sim = church({ faders: { "input:0": 0 }, on: { "input:0": true } });
  sim.al.start();
  sim.run(25);
  sim.talk("input:0", -3);
  sim.run(3);
  sim.faders["input:0"] += 20;                     // console snaps 0.2 dB
  sim.run(3);
  assert.doesNotMatch(sim.al.getStatus().message, /von Hand/);
});

test("feedback cuts immediately, blocks raising and opening", () => {
  const sim = church({ faders: { "input:0": 300 }, on: { "input:0": true } });
  sim.al.start();
  sim.run(25);
  sim.talk("input:0", -10);
  sim.run(3);
  const before = sim.faders["input:0"];
  sim.setFeedback(true);
  sim.run(1);
  assert.ok(sim.faders["input:0"] <= before - 300, `cut ${before} → ${sim.faders["input:0"]}`);
  assert.match(sim.al.getStatus().message, /Rückkopplung\?/);
  sim.setFeedback(false);
  sim.talk("input:1");
  sim.run(2);
  assert.equal(sim.on["input:1"], false, "nothing opened right after feedback");
});

test("opens without room level, but holds the fader", () => {
  const sim = church();
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  // speaker meters only, no room mic
  for (let i = 0; i < 20; i++) {
    sim.skip(100);
    sim.al.setMeters(new Map([["input:0", 80 + (i % 10 < 8 ? 0 : -30)], ["input:1", 20]]));
    sim.al.tick();
  }
  assert.equal(sim.on["input:0"], true);
  assert.equal(sim.faders["input:0"], -1000);
  assert.match(sim.al.getStatus().message, /kein Pegel von den Raum-Mikros/);
});

test("needs room mics, channels and a reference before starting", () => {
  const sim = church();
  sim.al.config.roomMics = [];
  assert.match(sim.al.start()!, /Raum-Mikrofone/);
  sim.al.config.roomMics = [{ kind: "input", index: 2 }];
  sim.al.config.channels = [];
  assert.match(sim.al.start()!, /Mikrofone/);
  sim.al.config.channels = [{ kind: "input", index: 0 }];
  sim.al.config.reference = null;
  assert.match(sim.al.start()!, /So soll es klingen/);
});

test("drops settings of older versions", () => {
  const al = new AutoLevel(
    { now: () => 0, fader: () => 0, isOn: () => true, setFader: () => {}, setOn: () => {}, label: () => "" },
    { maxBoost: 6, maxCut: 10 } as any,
  );
  assert.equal("maxBoost" in al.config, false);
  assert.equal(al.config.minLevel, -20);
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

test("detects the speaker by the mic's own noise floor", () => {
  const sim = church({ faders: { "input:0": 0, "input:1": 0 }, on: { "input:0": true, "input:1": true } });
  sim.al.start();
  sim.run(25);
  sim.talk("input:1");              // Pult: 20 → 50 raw; Kanzel overhears 50 → 54 (higher raw value!)
  sim.run(3);
  assert.equal(sim.al.getStatus().active, "Pult");
  sim.talk("input:0");
  sim.run(3);
  assert.equal(sim.al.getStatus().active, "Kanzel");
});

test("a long speech with few pauses keeps the mic open", () => {
  const sim = church();
  sim.al.config.closeAfter = 15;
  sim.al.start();
  sim.run(25);
  sim.talk("input:0");
  sim.run(1);
  assert.equal(sim.on["input:0"], true);
  // 3 minutes of speech: the helper makes 20 % pauses; the mic must stay the speaker throughout.
  for (let i = 0; i < 18; i++) {
    sim.run(10);
    assert.equal(sim.al.getStatus().active, "Kanzel", `after ${(i + 1) * 10} s`);
  }
  assert.equal(sim.on["input:0"], true);
});

test("follows a speaker who gets louder and quieter", () => {
  const sim = church({ faders: { "input:0": 0 }, on: { "input:0": true } });
  sim.al.config.ceiling = 10;
  sim.al.start();
  sim.run(25);
  sim.talk("input:0", 0);
  sim.run(15);
  const normal = sim.faders["input:0"];
  assert.ok(Math.abs(normal) <= 150, `normal ${normal}`);
  sim.talk("input:0", 5);                          // speaks 5 dB louder
  sim.run(20);
  assert.ok(Math.abs(sim.faders["input:0"] - (normal - 500)) <= 150, `louder → ${sim.faders["input:0"]}`);
  sim.talk("input:0", -4);                         // and then quieter
  sim.run(25);
  assert.ok(Math.abs(sim.faders["input:0"] - 400) <= 150, `quieter → ${sim.faders["input:0"]}`);
});

test("averages two room mics and ignores speech pauses", () => {
  let now = 0;
  const io = { now: () => now, fader: () => 0, isOn: () => true, setFader: () => {}, setOn: () => {}, label: () => "CH" };
  const al = new AutoLevel(io, {
    channels: [{ kind: "input", index: 0 }], roomMics: [{ kind: "input", index: 2 }, { kind: "input", index: 3 }], reference: -30,
  });
  for (let i = 0; i < 100; i++) {
    now += 100;
    const word = i % 10 < 7;
    al.setMeters(new Map([["input:0", 20], ["input:2", word ? 96 : 50], ["input:3", word ? 96 : 50]]));
  }
  assert.equal(al.takeReference(), null);
  assert.equal(al.config.reference, -30);
});

test("waits without console meters instead of guessing the speaker", () => {
  let now = 0;
  const io = { now: () => now, fader: () => 0, isOn: () => true, setFader: () => { throw new Error("must not move"); }, setOn: () => {}, label: () => "CH" };
  const al = new AutoLevel(io, { channels: [{ kind: "input", index: 0 }], roomMics: [{ kind: "input", index: 2 }], reference: -30 });
  al.start();
  now += 5000;
  al.tick();
  assert.match(al.getStatus().message, /Keine Pegel vom Pult/);
  assert.equal(al.getStatus().active, null);
});
