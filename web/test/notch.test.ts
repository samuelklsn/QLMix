import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEq } from "../shared/rcp.ts";
import { planNotch, hzText, NOTCH_MAX_DB } from "../server/notch.ts";

test("uses a free bell band closest in frequency and remembers the old band", () => {
  const eq = defaultEq();                       // 125 / 1k / 4k / 10k, all 0 dB
  const p = planNotch(eq, [], 2500);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.band, 2, "HI-MID (4 kHz) is closest to 2.5 kHz");
  assert.deepEqual(p.value, { freq: 2500, gain: -6, q: 8 });
  assert.deepEqual(p.notch.orig, { freq: 4000, gain: 0, q: 0.7 });
});

test("never touches bands the technician set, shelves or the low-pass", () => {
  const eq = defaultEq();
  eq.bands[1].gain = 2; eq.bands[2].gain = -3;  // the technician's EQ
  eq.lowShelf = true; eq.highLpf = true;
  const p = planNotch(eq, [], 2500);
  assert.deepEqual(p, { ok: false, reason: "kein freies EQ-Band" });
});

test("feedback near an existing notch deepens it, down to −12 dB", () => {
  const eq = defaultEq();
  const first = planNotch(eq, [], 2500);
  assert.ok(first.ok);
  if (!first.ok) return;
  let notches = [first.notch];
  const second = planNotch(eq, notches, 2600);
  assert.ok(second.ok && second.deepened && second.notch.gain === -9 && second.band === first.band);
  if (!second.ok) return;
  notches = [second.notch];
  const third = planNotch(eq, notches, 2500);
  assert.ok(third.ok && third.notch.gain === NOTCH_MAX_DB);
  if (!third.ok) return;
  const fourth = planNotch(eq, [third.notch], 2500);
  assert.equal(fourth.ok, false);
});

test("a second frequency takes another free band; EQ off is refused", () => {
  const eq = defaultEq();
  const a = planNotch(eq, [], 2500);
  assert.ok(a.ok);
  if (!a.ok) return;
  const b = planNotch(eq, [a.notch], 800);
  assert.ok(b.ok && b.band === 1);
  eq.on = false;
  assert.deepEqual(planNotch(eq, [], 800), { ok: false, reason: "EQ des Kanals ist aus" });
  assert.equal(hzText(2537), "2,5 kHz");
  assert.equal(hzText(403.2), "403 Hz");
});
