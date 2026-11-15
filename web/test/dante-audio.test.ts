import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, isDanteDevice, parseChannels, parseDshowDevices } from "../server/dante-audio.ts";

test("finds DirectShow audio devices in new and old ffmpeg output", () => {
  const modern = [
    '[dshow @ 000001e0] "Integrated Camera" (video)',
    '[dshow @ 000001e0]   Alternative name "@device_pnp_\\\\?\\usb#vid"',
    '[dshow @ 000001e0] "Dante Virtual Soundcard (x64)" (audio)',
    '[dshow @ 000001e0]   Alternative name "@device_cm_{33D9A762}\\wave_{1234}"',
    '[dshow @ 000001e0] "Mikrofon (Realtek(R) Audio)" (audio)',
  ].join("\r\n");
  assert.deepEqual(parseDshowDevices(modern), ["Dante Virtual Soundcard (x64)", "Mikrofon (Realtek(R) Audio)"]);
  const old = [
    "[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)",
    '[dshow @ 0x1]  "Integrated Camera"',
    "[dshow @ 0x1] DirectShow audio devices",
    '[dshow @ 0x1]  "DVS Receive  1-2 (Dante Virtual Soundcard)"',
    '[dshow @ 0x1]     Alternative name "@device_cm_{33D9A762}"',
  ].join("\n");
  assert.deepEqual(parseDshowDevices(old), ["DVS Receive  1-2 (Dante Virtual Soundcard)"]);
  assert.equal(isDanteDevice("DVS Receive  1-2 (Dante Virtual Soundcard)"), true);
  assert.equal(isDanteDevice("Mikrofon (Realtek(R) Audio)"), false);
});

test("reads the channel count of the output stream", () => {
  assert.equal(parseChannels("  Stream #0:0: Audio: pcm_f32le, 48000 Hz, stereo, flt, 3072 kb/s"), 2);
  assert.equal(parseChannels("  Stream #0:0: Audio: pcm_f32le, 48000 Hz, 16 channels, flt"), 16);
  assert.equal(parseChannels("  Stream #0:0: Audio: pcm_f32le, 48000 Hz, 7.1, flt"), 8);
  assert.equal(parseChannels("  Stream #0:0: Audio: pcm_f32le, 48000 Hz, mono, flt"), 1);
  assert.equal(parseChannels("nothing"), null);
});

test("matches an audio channel to the console input with the same level course", () => {
  let s = 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const speech = Array.from({ length: 200 }, (_, i) => (Math.sin(i / 3) > 0 ? -25 : -60) + 3 * rnd());
  const other = Array.from({ length: 200 }, (_, i) => (Math.sin(i / 7 + 1) > 0.3 ? -30 : -70) + 3 * rnd());
  const flat = Array.from({ length: 200 }, () => -90 + rnd());
  const inputs = new Map([["input:0", other], ["input:2", speech.map((v) => v + 40)], ["input:5", flat]]);
  // the Dante channel carries input 3 (different gain, a little noise)
  const audio = speech.map((v) => v - 12 + 2 * rnd());
  assert.equal(bestMatch(audio, inputs), "input:2");
  assert.equal(bestMatch(flat, inputs), null, "a silent channel matches nothing");
  assert.equal(bestMatch(audio.slice(0, 20), inputs), null, "too short");
});
