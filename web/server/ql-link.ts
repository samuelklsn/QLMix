// Second console connection for CL/QL: the editor protocol on TCP 50000 (MIDI Parameter
// Change SysEx), used here for EQ/HPF which the RCP text protocol doesn't expose.
//
// Observed console behaviour (QL5 V5.80a):
// * no handshake – requests are answered immediately;
// * the console answers only the most recent connection per client IP
//   (QL Editor on the same Mac and this server compete);
// * changes made elsewhere are not pushed – watched channels are polled;
// * read-back of a value written a moment ago may still return the old value for ~0.5 s.

import net from "node:net";
import { EventEmitter } from "node:events";
import {
  type ChannelId, type ConsoleModel, type EqSchema, type Key,
  QL_SCHEMA, QL_WRITABLE, allChannels, eqKey, eqParamsFor, hasEQ, parseQlKey, qlKey, qlParseChange, qlSysex,
} from "../shared/rcp.ts";
import { RACK_COUNT, allDynaKeys, allRackKeys, extraWritable } from "../shared/ql-params.ts";
import { INPUT_METER_REQUEST, decodeInputMeters } from "./autolevel.ts";

/** Everything a client may write over the editor protocol: EQ/HPF, dynamics, rack parameters. */
const WRITABLE: Record<number, number[]> = { ...QL_WRITABLE, ...extraWritable() };

const PORT = 50000;
const POLL_MS = 1500;
const KEEPALIVE_MS = 4000;
const WRITE_HOLD_MS = 1500;
const BATCH = 40;
const BATCH_INTERVAL_MS = 20;

export class QLLink extends EventEmitter {
  readonly values = new Map<Key, number>();
  status: "off" | "connecting" | "connected" | "failed" = "off";
  schema: EqSchema = { ...QL_SCHEMA };

  private host = "";
  private model?: ConsoleModel;
  private socket?: net.Socket;
  private gen = 0;
  private wants = false;
  private attempt = 0;
  private buf: Buffer = Buffer.alloc(0);
  private queue: number[][] = [];
  private pumping = false;
  private timers: NodeJS.Timeout[] = [];
  private lastWrite = new Map<Key, number>();
  private watched = new Map<string, ChannelId>();
  private watchedRacks = new Set<number>();
  private gotAnswer = false;
  private probeSink?: (elem: number, index: number, ch: number, value: number) => void;

  get available(): boolean {
    return this.status === "connected" && this.gotAnswer;
  }

  connect(host: string, model: ConsoleModel): void {
    if (this.wants && this.host === host && this.model?.name === model.name && this.status !== "failed") return;
    this.disconnect();
    this.host = host;
    this.model = model;
    this.schema = { ...QL_SCHEMA, inputCount: model.counts.input };
    this.wants = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wants = false;
    this.teardown();
    this.setStatus("off");
  }

  /** Channels whose EQ is open in some client – polled for changes made elsewhere. */
  setWatched(channels: ChannelId[]): void {
    this.watched = new Map(channels.map((c) => [`${c.kind}:${c.index}`, c]));
  }

  /** Racks whose page is open in some client – polled like watched channels. */
  setWatchedRacks(racks: number[]): void {
    this.watchedRacks = new Set(racks.filter((r) => Number.isInteger(r) && r >= 0 && r < RACK_COUNT));
  }

  /** Writes a value. Only parameters listed in WRITABLE are accepted. */
  set(k: Key, v: number): boolean {
    const p = parseQlKey(k);
    if (!p || !WRITABLE[p.elem]?.includes(p.index) || !Number.isInteger(v)) return false;
    if (Math.abs(v) > 10_000_000) return false;
    this.values.set(k, v);
    this.lastWrite.set(k, Date.now());
    this.write([qlSysex(p.elem, p.index, p.ch, v)]);
    return true;
  }

  // ------------------------------------------------------------ connection

  private open(): void {
    const gen = ++this.gen;
    this.buf = Buffer.alloc(0);
    this.gotAnswer = false;
    this.setStatus("connecting");
    const s = net.createConnection({ host: this.host, port: PORT });
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 5000);
    const timeout = setTimeout(() => { if (gen === this.gen && this.status === "connecting") this.lost(gen); }, 5000);
    this.timers.push(timeout);
    s.on("connect", () => {
      if (gen !== this.gen) return;
      this.attempt = 0;
      this.setStatus("connected");
      this.syncAll();
      const poll = setInterval(() => { if (gen === this.gen) this.poll(); }, POLL_MS);
      const keep = setInterval(() => { if (gen === this.gen && this.queue.length === 0) this.write([qlSysex(67, 2, 0)]); }, KEEPALIVE_MS);
      // Input meter stream (re-requested every few seconds, like QL Editor does).
      this.write([INPUT_METER_REQUEST]);
      const meters = setInterval(() => { if (gen === this.gen) this.write([INPUT_METER_REQUEST]); }, 5000);
      this.timers.push(poll, keep, meters);
    });
    s.on("data", (d: Buffer) => { if (gen === this.gen) this.receive(d); });
    s.on("error", () => this.lost(gen));
    s.on("close", () => this.lost(gen));
  }

  private lost(gen: number): void {
    if (gen !== this.gen) return;
    this.teardown();
    if (!this.wants) return;
    this.setStatus("failed");
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 15000);
    const expected = this.gen;
    this.timers.push(setTimeout(() => { if (this.wants && expected === this.gen) this.open(); }, delay));
  }

  private teardown(): void {
    this.gen += 1;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.queue = [];
    this.pumping = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on("error", () => {});
      this.socket.destroy();
      this.socket = undefined;
    }
  }

  private setStatus(s: QLLink["status"]): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("status");
  }

  // ------------------------------------------------------------ requests

  private request(keys: Key[]): number[][] {
    return keys.map((k) => { const p = parseQlKey(k)!; return qlSysex(p.elem, p.index, p.ch); });
  }

  private requestsFor(c: ChannelId): number[][] {
    const eq = hasEQ(c.kind) ? eqParamsFor(c, this.schema).map((e) => eqKey(c, e, this.schema)) : [];
    return this.request([...eq, ...allDynaKeys(c, this.schema)]);
  }

  private syncAll(): void {
    if (!this.model) return;
    const reqs = allChannels(this.model).flatMap((c) => this.requestsFor(c));
    for (let r = 0; r < RACK_COUNT; r++) reqs.push(...this.request(allRackKeys(r)));
    this.enqueue(reqs);
  }

  private poll(): void {
    if (this.queue.length > 0) return;
    const reqs = [...this.watched.values()].flatMap((c) => this.requestsFor(c));
    for (const r of this.watchedRacks) reqs.push(...this.request(allRackKeys(r)));
    this.enqueue(reqs);
  }

  private enqueue(msgs: number[][]): void {
    this.queue.push(...msgs);
    if (!this.pumping) this.pump();
  }

  private pump(): void {
    const batch = this.queue.splice(0, BATCH);
    if (batch.length === 0) { this.pumping = false; return; }
    this.pumping = true;
    this.write(batch);
    this.timers.push(setTimeout(() => this.pump(), BATCH_INTERVAL_MS));
  }

  private write(msgs: number[][]): void {
    if (!this.socket || this.status !== "connected") return;
    this.socket.write(Buffer.from(msgs.flat()));
  }

  // ------------------------------------------------------------ probing unknown elements

  /**
   * Reads elements whose layout is not known yet (e.g. the custom fader bank) and returns every
   * answered (index, ch) → value. Stage 1 scans index 0…maxIndex at ch 0 and ch 0…maxCh at index 0;
   * stage 2 reads the full grid of the answered indices × channels. Unanswered addresses are skipped
   * by the console, so the result shows the real shape of each element.
   */
  async probe(elems: number[], maxIndex = 47, maxCh = 127): Promise<{ elem: number; index: number; ch: number; value: number }[]> {
    if (this.status !== "connected" || this.probeSink) return [];
    const found = new Map<string, { elem: number; index: number; ch: number; value: number }>();
    const wanted = new Set(elems);
    this.probeSink = (elem, index, ch, value) => { if (wanted.has(elem)) found.set(`${elem}:${index}:${ch}`, { elem, index, ch, value }); };
    const settle = async () => {
      let last = -1;
      for (let i = 0; i < 200; i++) { // up to ~40 s
        await new Promise((r) => setTimeout(r, 200));
        if (this.queue.length === 0 && found.size === last) break;
        last = found.size;
      }
    };
    try {
      const stage1: number[][] = [];
      for (const e of elems) {
        for (let i = 0; i <= maxIndex; i++) stage1.push(qlSysex(e, i, 0));
        for (let c = 1; c <= maxCh; c++) stage1.push(qlSysex(e, 0, c));
      }
      this.enqueue(stage1);
      await settle();
      const stage2: number[][] = [];
      for (const e of elems) {
        const rows = [...found.values()].filter((f) => f.elem === e);
        // Cap the grid (32 indices × 64 channels) in case the console answers every address.
        const idx = [...new Set(rows.filter((f) => f.ch === 0).map((f) => f.index))].slice(0, 32);
        const chs = [...new Set(rows.filter((f) => f.index === 0).map((f) => f.ch))].slice(0, 64);
        for (const i of idx) for (const c of chs) if (!found.has(`${e}:${i}:${c}`)) stage2.push(qlSysex(e, i, c));
      }
      if (stage2.length) { this.enqueue(stage2); await settle(); }
    } finally {
      this.probeSink = undefined;
    }
    return [...found.values()].sort((a, b) => a.elem - b.elem || a.index - b.index || a.ch - b.ch);
  }

  // ------------------------------------------------------------ responses

  private receive(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let start: number;
    while ((start = this.buf.indexOf(0xf0)) >= 0) {
      const end = this.buf.indexOf(0xf7, start);
      if (end < 0) break;
      const m = this.buf.subarray(start, end + 1);
      this.buf = this.buf.subarray(end + 1);
      if (m[5] === 0x21) {
        const levels = decodeInputMeters(m);
        if (levels) this.emit("inmeters", levels);
        continue;
      }
      const change = qlParseChange(m);
      if (!change) continue; // other meters, heartbeats (0x7f), …
      this.probeSink?.(change.elem, change.index, change.ch, change.value);
      if (!this.gotAnswer) {
        this.gotAnswer = true;
        this.emit("status");
      }
      const k = qlKey(change.elem, change.index, change.ch);
      // Ignore stale read-backs right after our own write.
      const written = this.lastWrite.get(k);
      if (written !== undefined && Date.now() - written < WRITE_HOLD_MS) continue;
      if (this.values.get(k) === change.value) continue;
      this.values.set(k, change.value);
      this.emit("param", k, change.value);
    }
    if (this.buf.length > 65536) this.buf = Buffer.alloc(0);
  }
}
