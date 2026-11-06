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
  private gotAnswer = false;

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
    this.watched = new Map(channels.filter((c) => hasEQ(c.kind)).map((c) => [`${c.kind}:${c.index}`, c]));
  }

  /** Writes a value. Only EQ/HPF parameters listed in QL_WRITABLE are accepted. */
  set(k: Key, v: number): boolean {
    const p = parseQlKey(k);
    if (!p || !QL_WRITABLE[p.elem]?.includes(p.index) || !Number.isInteger(v)) return false;
    if (Math.abs(v) > 200) return false;
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
      this.timers.push(poll, keep);
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

  private requestsFor(c: ChannelId): number[][] {
    return eqParamsFor(c, this.schema).map((e) => {
      const p = parseQlKey(eqKey(c, e, this.schema))!;
      return qlSysex(p.elem, p.index, p.ch);
    });
  }

  private syncAll(): void {
    if (!this.model) return;
    const reqs = allChannels(this.model).filter((c) => hasEQ(c.kind)).flatMap((c) => this.requestsFor(c));
    this.enqueue(reqs);
  }

  private poll(): void {
    if (this.queue.length > 0) return;
    this.enqueue([...this.watched.values()].flatMap((c) => this.requestsFor(c)));
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

  // ------------------------------------------------------------ responses

  private receive(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let start: number;
    while ((start = this.buf.indexOf(0xf0)) >= 0) {
      const end = this.buf.indexOf(0xf7, start);
      if (end < 0) break;
      const m = this.buf.subarray(start, end + 1);
      this.buf = this.buf.subarray(end + 1);
      const change = qlParseChange(m);
      if (!change) continue; // meters (0x21), heartbeats (0x7f), …
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
