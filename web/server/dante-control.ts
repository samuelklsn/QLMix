// Dante control (ARC protocol over UDP) – just enough to put a room mic on a free receive channel
// of the Dante Virtual Soundcard on this PC. Packet formats follow the open-source project
// "netaudio" (github.com/chris-ritsen/network-audio-controller, netaudio-core/src/commands).
//
// Safety: this module only READS other devices (channel lists). It WRITES subscriptions only to
// the receive channels of the device it is given – the caller passes our own soundcard and only
// channels that are free. It never sends any of the device-management commands (rename, reset …).

import dgram from "node:dgram";
import os from "node:os";

export const ARC_PROTOCOL = 0x27ff;
export const ARC_PORT = 4440;
const OP_CHANNEL_COUNT = 0x1000;
const OP_RX_CHANNELS = 0x3000;
const OP_SUBSCRIPTION_ADD = 0x3010;
const OP_SUBSCRIPTION_REMOVE = 0x3014;
const RESULT_SUCCESS = 0x0001;
const RESULT_MORE_PAGES = 0x8112;
const RESPONSE_HEADER = 10;
const RX_PER_PAGE = 16;
const RX_RECORD = 20;
/** Records + padding before the string table of an add-subscription packet. */
const SUB_STRING_TABLE_ALIGN = 44;

// ---------------------------------------------------------------- packets (pure)

/** [protocol][length][message id][opcode][body] – all big-endian. */
export function arcPacket(opcode: number, id: number, body: Buffer | number[]): Buffer {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const p = Buffer.alloc(8 + b.length);
  p.writeUInt16BE(ARC_PROTOCOL, 0);
  p.writeUInt16BE(p.length, 2);
  p.writeUInt16BE(id & 0xffff, 4);
  p.writeUInt16BE(opcode, 6);
  b.copy(p, 8);
  return p;
}

export const channelCountRequest = (id: number) => arcPacket(OP_CHANNEL_COUNT, id, [0, 0]);
export const rxChannelsRequest = (start: number, id: number) => arcPacket(OP_RX_CHANNELS, id, [0, 0, 0, 1, start >> 8, start & 0xff, 0, 0]);

export interface Subscription { rx: number; txChannel: string; txDevice: string }

const validName = (s: string) => s.length > 0 && s.length <= 31 && !/[\x00-\x1f]/.test(s);

export function addSubscriptionsRequest(subs: Subscription[], id: number): Buffer {
  if (subs.length < 1 || subs.length > 16) throw new Error("1–16 subscriptions per packet");
  const prefix = 4 + 6 * subs.length;
  const tableStart = 8 + Math.max(prefix, SUB_STRING_TABLE_ALIGN);
  const strings: Buffer[] = [];
  let tableLen = 0;
  const records: number[] = [0x00, 0x00, 0x02, subs.length];
  for (const s of subs) {
    if (!Number.isInteger(s.rx) || s.rx < 1 || s.rx > 255) throw new Error(`invalid rx channel ${s.rx}`);
    if (!validName(s.txChannel) || !validName(s.txDevice)) throw new Error("invalid Dante name");
    const ch = tableStart + tableLen;
    strings.push(Buffer.from(`${s.txChannel}\0`, "utf8"));
    tableLen += Buffer.byteLength(s.txChannel) + 1;
    const dev = tableStart + tableLen;
    strings.push(Buffer.from(`${s.txDevice}\0`, "utf8"));
    tableLen += Buffer.byteLength(s.txDevice) + 1;
    records.push(0x00, s.rx, ch >> 8, ch & 0xff, dev >> 8, dev & 0xff);
  }
  const body = Buffer.concat([Buffer.from(records), Buffer.alloc(Math.max(0, SUB_STRING_TABLE_ALIGN - prefix)), ...strings]);
  return arcPacket(OP_SUBSCRIPTION_ADD, id, body);
}

export function removeSubscriptionsRequest(rx: number[], id: number): Buffer {
  if (!rx.length || rx.some((c) => !Number.isInteger(c) || c < 1)) throw new Error("invalid rx channels");
  const body = Buffer.alloc(4 + 4 * rx.length);
  body.writeUInt32BE(rx.length, 0);
  rx.forEach((c, i) => body.writeUInt32BE(c, 4 + 4 * i));
  return arcPacket(OP_SUBSCRIPTION_REMOVE, id, body);
}

export interface ArcResponse { protocol: number; id: number; opcode: number; result: number; raw: Buffer }

export function parseArcResponse(raw: Buffer): ArcResponse | null {
  if (raw.length < RESPONSE_HEADER || raw.readUInt16BE(2) !== raw.length) return null;
  return { protocol: raw.readUInt16BE(0), id: raw.readUInt16BE(4), opcode: raw.readUInt16BE(6), result: raw.readUInt16BE(8), raw };
}

export const accepted = (r: ArcResponse) => r.result === RESULT_SUCCESS || r.result === RESULT_MORE_PAGES;

export function parseChannelCount(r: ArcResponse): { tx: number; rx: number } | null {
  if (r.opcode !== OP_CHANNEL_COUNT || !accepted(r) || r.raw.length < 16) return null;
  return { tx: r.raw.readUInt16BE(12), rx: r.raw.readUInt16BE(14) };
}

function stringAt(raw: Buffer, ptr: number, min: number): string | null {
  if (ptr === 0 || ptr < min || ptr >= raw.length) return null;
  const end = raw.indexOf(0, ptr);
  return end < 0 ? null : raw.toString("utf8", ptr, end);
}

export interface RxChannel { number: number; name: string | null; txChannel: string | null; txDevice: string | null; status: number }

/** One page (≤ 16) of receive channels starting at `start`. */
export function parseRxPage(r: ArcResponse, start: number): RxChannel[] | null {
  if (r.opcode !== OP_RX_CHANNELS || !accepted(r)) return null;
  const body = r.raw.subarray(RESPONSE_HEADER);
  if (body.length < 2) return null;
  const max = body[0], count = body[1];
  if (max > RX_PER_PAGE || count > max) return null;
  const tableEnd = 2 + max * RX_RECORD;
  if (body.length < tableEnd) return null;
  const min = RESPONSE_HEADER + tableEnd;
  const out: RxChannel[] = [];
  for (let i = 0; i < count; i++) {
    const o = 2 + i * RX_RECORD;
    const number = body.readUInt16BE(o);
    if (number !== start + i) return null;
    out.push({
      number,
      txChannel: stringAt(r.raw, body.readUInt16BE(o + 6), min),
      txDevice: stringAt(r.raw, body.readUInt16BE(o + 8), min),
      name: stringAt(r.raw, body.readUInt16BE(o + 10), min),
      status: body.readUInt16BE(o + 14),
    });
  }
  return out;
}

// ---------------------------------------------------------------- UDP client

export interface DanteDevice { name: string; host: string; port: number }

let nextId = Math.floor(Math.random() * 60000) + 1;

/** Sends one ARC request and waits for the answer with the same message id (3 tries). */
export async function arcRequest(dev: DanteDevice, build: (id: number) => Buffer, timeoutMs = 800): Promise<ArcResponse> {
  const sock = dgram.createSocket("udp4");
  try {
    await new Promise<void>((res, rej) => { sock.once("error", rej); sock.bind(0, () => res()); });
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = (nextId = (nextId % 65535) + 1);
      const reply = new Promise<ArcResponse | null>((res) => {
        const t = setTimeout(() => { sock.off("message", on); res(null); }, timeoutMs);
        const on = (msg: Buffer) => {
          const r = parseArcResponse(msg);
          if (r && r.id === id) { clearTimeout(t); sock.off("message", on); res(r); }
        };
        sock.on("message", on);
      });
      sock.send(build(id), dev.port, dev.host);
      const r = await reply;
      if (r) return r;
    }
    throw new Error(`${dev.name} antwortet nicht`);
  } finally {
    sock.close();
  }
}

/** All receive channels of a device (paged, 16 per request). */
export async function readRxChannels(dev: DanteDevice): Promise<RxChannel[]> {
  const count = parseChannelCount(await arcRequest(dev, channelCountRequest));
  if (!count) throw new Error(`${dev.name}: Kanalzahl nicht lesbar`);
  const out: RxChannel[] = [];
  for (let start = 1; start <= count.rx; start += RX_PER_PAGE) {
    const page = parseRxPage(await arcRequest(dev, (id) => rxChannelsRequest(start, id)), start);
    if (!page) throw new Error(`${dev.name}: Empfangskanäle nicht lesbar`);
    out.push(...page);
    if (page.length < RX_PER_PAGE) break;
  }
  return out;
}

export async function addSubscriptions(dev: DanteDevice, subs: Subscription[]): Promise<void> {
  const r = await arcRequest(dev, (id) => addSubscriptionsRequest(subs, id));
  if (!accepted(r)) throw new Error(`${dev.name} lehnt die Zuweisung ab (Code ${r.result})`);
}

export async function removeSubscriptions(dev: DanteDevice, rx: number[]): Promise<void> {
  const r = await arcRequest(dev, (id) => removeSubscriptionsRequest(rx, id));
  if (!accepted(r)) throw new Error(`${dev.name} lehnt das Entfernen ab (Code ${r.result})`);
}

// ---------------------------------------------------------------- discovery (mDNS)

const SERVICE = "_netaudio-arc._udp.local";

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split(".").filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}

/** PTR question with the "unicast response" bit – answers come back to our own port. */
export function mdnsQuery(service = SERVICE): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(service), Buffer.from([0x00, 0x0c, 0x80, 0x01])]);
}

function readName(buf: Buffer, off: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1, hops = 0;
  while (off < buf.length && hops++ < 64) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    labels.push(buf.toString("utf8", off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join("."), next: next < 0 ? off : next };
}

/** Collects PTR/SRV/A records of an mDNS answer. */
export function parseMdns(buf: Buffer): { ptr: string[]; srv: Map<string, { target: string; port: number }>; a: Map<string, string> } {
  const ptr: string[] = [], srv = new Map<string, { target: string; port: number }>(), a = new Map<string, string>();
  if (buf.length < 12) return { ptr, srv, a };
  const qd = buf.readUInt16BE(4), records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).next + 4;
  for (let i = 0; i < records && off < buf.length; i++) {
    const { name, next } = readName(buf, off);
    const type = buf.readUInt16BE(next), len = buf.readUInt16BE(next + 8), data = next + 10;
    if (type === 12) ptr.push(readName(buf, data).name);
    else if (type === 33) srv.set(name.toLowerCase(), { port: buf.readUInt16BE(data + 4), target: readName(buf, data + 6).name.toLowerCase() });
    else if (type === 1 && len === 4) a.set(name.toLowerCase(), `${buf[data]}.${buf[data + 1]}.${buf[data + 2]}.${buf[data + 3]}`);
    off = data + len;
  }
  return { ptr, srv, a };
}

/** Finds Dante devices (ARC service) on every IPv4 network of this PC. */
export async function discoverDevices(timeoutMs = 2500): Promise<DanteDevice[]> {
  const ptr = new Set<string>();
  const srv = new Map<string, { target: string; port: number }>(), a = new Map<string, string>();
  const from = new Map<string, string>();
  const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal) as os.NetworkInterfaceInfo[];
  const sockets: dgram.Socket[] = [];
  await Promise.all(ifaces.map((i) => new Promise<void>((res) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(s);
    s.on("error", () => res());
    s.on("message", (msg, rinfo) => {
      const m = parseMdns(msg);
      for (const p of m.ptr) { ptr.add(p); from.set(p.toLowerCase(), rinfo.address); }
      for (const [k, v] of m.srv) { srv.set(k, v); from.set(k, rinfo.address); }
      for (const [k, v] of m.a) a.set(k, v);
    });
    s.bind(0, i.address, () => {
      try { s.setMulticastInterface(i.address); s.send(mdnsQuery(), 5353, "224.0.0.251"); } catch { /* interface without multicast */ }
      res();
    });
  })));
  // Many hardware devices answer only by multicast to port 5353 – listen there too (shared port).
  const mc = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sockets.push(mc);
  mc.on("error", () => {});
  mc.on("message", (msg, rinfo) => {
    const m = parseMdns(msg);
    for (const p of m.ptr) if (p.toLowerCase().endsWith(SERVICE.toLowerCase())) { ptr.add(p); from.set(p.toLowerCase(), rinfo.address); }
    for (const [k, v] of m.srv) { srv.set(k, v); if (!from.has(k)) from.set(k, rinfo.address); }
    for (const [k, v] of m.a) a.set(k, v);
  });
  await new Promise<void>((res) => {
    mc.bind(5353, () => {
      for (const i of ifaces) try { mc.addMembership("224.0.0.251", i.address); } catch { /* already joined */ }
      // Plain query (no unicast bit) so devices answer to the group as well.
      const q = mdnsQuery(); q[q.length - 2] = 0x00;
      for (const i of ifaces) try { mc.setMulticastInterface(i.address); mc.send(q, 5353, "224.0.0.251"); } catch { /* skip */ }
      res();
    });
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const s of sockets) try { s.close(); } catch { /* closed */ }
  const out: DanteDevice[] = [];
  for (const instance of ptr) {
    const key = instance.toLowerCase();
    const name = instance.slice(0, instance.toLowerCase().indexOf(`.${SERVICE.toLowerCase()}`)) || instance.split(".")[0];
    const s = srv.get(key);
    const host = (s && a.get(s.target)) ?? from.get(key);
    if (host) out.push({ name, host, port: s?.port ?? ARC_PORT });
  }
  return out;
}

export const localAddresses = () =>
  Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4").map((i) => i!.address);
