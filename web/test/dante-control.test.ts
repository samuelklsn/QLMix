import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import {
  addSubscriptionsRequest, removeSubscriptionsRequest, rxChannelsRequest, parseArcResponse, parseRxPage, parseMdns,
  readRxChannels, addSubscriptions, removeSubscriptions, type RxChannel,
} from "../server/dante-control.ts";
import { DanteRouter, type DanteRoute } from "../server/dante-router.ts";

/** Decoder written after netaudio-core `parse_add_subscriptions_request` – an independent check of our encoder. */
function netaudioParseAdd(d: Buffer) {
  assert.equal(d.readUInt16BE(0), 0x27ff, "protocol");
  assert.equal(d.readUInt16BE(2), d.length, "length");
  assert.equal(d.readUInt16BE(6), 0x3010, "opcode");
  assert.equal(d.readUInt16BE(8), 0);
  assert.equal(d[10], 2);
  const count = d[11];
  const recordsEnd = 8 + 4 + 6 * count;
  const minPtr = Math.max(recordsEnd, 8 + 44);
  const str = (p: number) => d.toString("utf8", p, d.indexOf(0, p));
  return Array.from({ length: count }, (_, i) => {
    const o = 12 + 6 * i;
    const rx = d.readUInt16BE(o), cp = d.readUInt16BE(o + 2), dp = d.readUInt16BE(o + 4);
    assert.ok(rx > 0 && cp >= minPtr && dp >= minPtr, "pointers behind the record block");
    return { rx, txChannel: str(cp), txDevice: str(dp) };
  });
}

test("add-subscription packet: exact bytes and the netaudio layout", () => {
  const p = addSubscriptionsRequest([{ rx: 9, txChannel: "03", txDevice: "Rio3224-D2-1" }], 0x1234);
  assert.equal(p.subarray(0, 18).toString("hex"), "27ff00" + p.length.toString(16) + "1234" + "3010" + "00000201" + "0009" + "0034" + "0037");
  assert.equal(p.length, 52 + 3 + 13);
  assert.deepEqual(netaudioParseAdd(p), [{ rx: 9, txChannel: "03", txDevice: "Rio3224-D2-1" }]);
  const two = addSubscriptionsRequest([{ rx: 16, txChannel: "23", txDevice: "Rio" }, { rx: 15, txChannel: "24", txDevice: "Rio" }], 7);
  assert.deepEqual(netaudioParseAdd(two), [{ rx: 16, txChannel: "23", txDevice: "Rio" }, { rx: 15, txChannel: "24", txDevice: "Rio" }]);
  assert.throws(() => addSubscriptionsRequest([{ rx: 0, txChannel: "1", txDevice: "x" }], 1));
});

test("remove-subscription and rx-channel query packets", () => {
  assert.equal(removeSubscriptionsRequest([9, 10], 1).toString("hex"), "27ff00140001" + "3014" + "00000002" + "00000009" + "0000000a");
  assert.equal(rxChannelsRequest(17, 2).toString("hex"), "27ff00100002" + "3000" + "0000000100110000");
});

// ---------------------------------------------------------------- a fake Dante device

interface FakeRx { name: string; tx?: [string, string] }

/** Answers channel count, rx pages, add/remove like a Dante device (UDP on 127.0.0.1). */
async function fakeDevice(rx: FakeRx[]) {
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  const reply = (req: Buffer, result: number, body: Buffer) => {
    const out = Buffer.alloc(10 + body.length);
    req.copy(out, 0, 0, 8);
    out.writeUInt16BE(out.length, 2);
    out.writeUInt16BE(result, 8);
    body.copy(out, 10);
    return out;
  };
  sock.on("message", (m, r) => {
    const op = m.readUInt16BE(6);
    let res: Buffer;
    if (op === 0x1000) { const b = Buffer.alloc(6); b.writeUInt16BE(0, 2); b.writeUInt16BE(rx.length, 4); res = reply(m, 1, b); }
    else if (op === 0x3000) {
      const start = m.readUInt16BE(12);
      const page = rx.slice(start - 1, start - 1 + 16);
      const table = 2 + 16 * 20;
      const strings: Buffer[] = [];
      let at = 10 + table;
      const put = (s: string) => { const p = at; strings.push(Buffer.from(`${s}\0`)); at += Buffer.byteLength(s) + 1; return p; };
      const body = Buffer.alloc(table);
      body[0] = 16; body[1] = page.length;
      page.forEach((c, i) => {
        const o = 2 + i * 20;
        body.writeUInt16BE(start + i, o);
        if (c.tx) { body.writeUInt16BE(put(c.tx[0]), o + 6); body.writeUInt16BE(put(c.tx[1]), o + 8); }
        body.writeUInt16BE(put(c.name), o + 10);
      });
      res = reply(m, start + 15 < rx.length ? 0x8112 : 1, Buffer.concat([body, ...strings]));
    } else if (op === 0x3010) {
      for (const s of netaudioParseAdd(m)) rx[s.rx - 1].tx = [s.txChannel, s.txDevice];
      res = reply(m, 1, Buffer.alloc(0));
    } else if (op === 0x3014) {
      const n = m.readUInt32BE(8);
      for (let i = 0; i < n; i++) delete rx[m.readUInt32BE(12 + 4 * i) - 1].tx;
      res = reply(m, 1, Buffer.alloc(0));
    } else return;
    sock.send(res, r.port, r.address);
  });
  return { dev: { name: "PC-DVS", host: "127.0.0.1", port: (sock.address() as { port: number }).port }, rx, close: () => sock.close() };
}

test("over UDP: reads 20 receive channels in two pages, adds and removes a subscription", async () => {
  const f = await fakeDevice(Array.from({ length: 20 }, (_, i) => ({ name: String(i + 1).padStart(2, "0"), tx: i < 2 ? ["05", "QL5"] as [string, string] : undefined })));
  try {
    let ch: RxChannel[] = await readRxChannels(f.dev);
    assert.equal(ch.length, 20);
    assert.deepEqual(ch[0], { number: 1, name: "01", txChannel: "05", txDevice: "QL5", status: 0 });
    assert.equal(ch[19].txChannel, null);
    await addSubscriptions(f.dev, [{ rx: 16, txChannel: "23", txDevice: "Rio3224-D2-1" }]);
    ch = await readRxChannels(f.dev);
    assert.equal(ch[15].txChannel, "23");
    await removeSubscriptions(f.dev, [16]);
    ch = await readRxChannels(f.dev);
    assert.equal(ch[15].txChannel, null);
  } finally { f.close(); }
});

test("mDNS answer with name compression", () => {
  const name = (s: string) => Buffer.concat([...s.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (n: Buffer, type: number, data: Buffer) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt16BE(data.length, 8); return Buffer.concat([n, h, data]); };
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0]);
  const svc = name("_netaudio-arc._udp.local");                      // at offset 12
  const ptrData = Buffer.concat([Buffer.from([4]), Buffer.from("PC-1"), Buffer.from([0xc0, 12])]);
  const ptr = rr(svc, 12, ptrData);
  const instOff = 12 + svc.length + 10;                               // "PC-1.<svc>" inside the PTR data
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x11, 0x58]), name("pc-1.local")]);
  const srv = rr(Buffer.from([0xc0, instOff]), 33, srvData);
  const a = rr(name("pc-1.local"), 1, Buffer.from([192, 168, 1, 50]));
  const m = parseMdns(Buffer.concat([header, ptr, srv, a]));
  assert.deepEqual(m.ptr, ["PC-1._netaudio-arc._udp.local"]);
  assert.deepEqual(m.srv.get("pc-1._netaudio-arc._udp.local"), { port: 4440, target: "pc-1.local" });
  assert.equal(m.a.get("pc-1.local"), "192.168.1.50");
});

// ---------------------------------------------------------------- the router

function routerWorld(opts: { roomMicIndex: number; consoleRx: Record<number, [string, string]>; carries: Record<string, string> }) {
  let now = 0;
  const own = { name: "KIRCHE-PC", host: "192.168.1.50", port: 4440 };
  const ql = { name: "Y001-Yamaha-QL5-0a1b2c", host: "192.168.1.60", port: 4440 };
  const ownRx: RxChannel[] = Array.from({ length: 16 }, (_, i) => ({ number: i + 1, name: String(i + 1), txChannel: i >= 4 && i < 8 ? "07" : null, txDevice: i >= 4 && i < 8 ? "Sampler-PC" : null, status: 0 }));
  const qlRx: RxChannel[] = Object.entries(opts.consoleRx).map(([n, [c, d]]) => ({ number: Number(n), name: n, txChannel: c, txDevice: d, status: 0 }));
  const log: string[] = [];
  let routes: DanteRoute[] = [];
  const io = {
    discover: async () => [own, ql, { name: "Rio3224-D2-1", host: "192.168.1.70", port: 4440 }],
    localIps: () => ["127.0.0.1", "192.168.1.50"],
    readRx: async (d: { name: string }) => (d === own ? ownRx : qlRx).map((c) => ({ ...c })),
    add: async (d: { name: string }, subs: { rx: number; txChannel: string; txDevice: string }[]) => {
      assert.equal(d, own, "only our own soundcard is ever written");
      for (const s of subs) { assert.equal(ownRx[s.rx - 1].txChannel, null, "only free channels"); ownRx[s.rx - 1].txChannel = s.txChannel; ownRx[s.rx - 1].txDevice = s.txDevice; }
      log.push(`add ${subs.map((s) => `${s.rx}<-${s.txChannel}@${s.txDevice}`).join(",")}`);
    },
    remove: async (d: { name: string }, rx: number[]) => {
      assert.equal(d, own);
      for (const r of rx) { ownRx[r - 1].txChannel = null; ownRx[r - 1].txDevice = null; }
      log.push(`remove ${rx.join(",")}`);
    },
    roomMics: () => [{ key: `input:${opts.roomMicIndex}`, index: opts.roomMicIndex, label: `CH ${opts.roomMicIndex + 1} Raum` }],
    // the channel matches when it now carries the source that feeds the room mic
    correlate: (rx: number) => (ownRx[rx - 1].txChannel && opts.carries[`${ownRx[rx - 1].txChannel}@${ownRx[rx - 1].txDevice}`] === "room" ? 0.93 : 0.1),
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    routes: () => routes,
    saveRoutes: (r: DanteRoute[]) => { routes = r; },
    log: () => {},
  };
  return { router: new DanteRouter(io), ownRx, log, routes: () => routes };
}

test("router: finds the room mic on the first try with the default patch, uses a free channel from the top", async () => {
  const w = routerWorld({ roomMicIndex: 22, consoleRx: { 22: ["22", "Rio3224-D2-1"], 23: ["23", "Rio3224-D2-1"], 24: ["24", "Rio3224-D2-1"] }, carries: { "23@Rio3224-D2-1": "room" } });
  await w.router.autoRoute();
  assert.equal(w.router.status.state, "done", w.router.status.message);
  assert.deepEqual(w.routes().map((r) => [r.rx, r.txChannel]), [[16, "23"]]);
  assert.match(w.log[0], /^add 16<-23@Rio3224-D2-1,15<-2[24]@/, "CH 23 first, then a neighbour");
  assert.equal(w.ownRx[14].txChannel, null, "test subscriptions that did not match are removed");
  assert.equal(w.ownRx[4].txDevice, "Sampler-PC", "existing subscriptions are never touched");
});

test("router: searches further when the patch is not 1:1, and gives up cleanly", async () => {
  const consoleRx: Record<number, [string, string]> = {};
  for (let n = 1; n <= 32; n++) consoleRx[n] = [String(n), "Rio3224-D2-1"];
  const w = routerWorld({ roomMicIndex: 2, consoleRx, carries: { "17@Rio3224-D2-1": "room" } });
  await w.router.autoRoute();
  assert.equal(w.router.status.state, "done", w.router.status.message);
  assert.equal(w.routes()[0].txChannel, "17");
  assert.equal(w.ownRx.filter((c) => c.txDevice === "Rio3224-D2-1").length, 1, "only the winner stays");

  const none = routerWorld({ roomMicIndex: 2, consoleRx: { 1: ["1", "Rio"], 2: ["2", "Rio"] }, carries: {} });
  await none.router.autoRoute();
  assert.equal(none.router.status.state, "error");
  assert.match(none.router.status.message, /auf keinem Dante-Eingang gefunden/);
  assert.equal(none.ownRx.filter((c) => c.txDevice === "Rio").length, 0, "nothing left behind");
});

test("router: removing takes away only what QLMix set", async () => {
  const w = routerWorld({ roomMicIndex: 0, consoleRx: { 1: ["01", "Rio"] }, carries: { "01@Rio": "room" } });
  await w.router.autoRoute();
  assert.equal(w.routes().length, 1);
  await w.router.removeAll();
  assert.equal(w.routes().length, 0);
  assert.equal(w.ownRx[15].txChannel, null);
  assert.equal(w.ownRx[4].txDevice, "Sampler-PC");
});
