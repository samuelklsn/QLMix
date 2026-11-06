// Client state: mirrors the server's parameter cache and sends changes back.

import { SvelteMap } from "svelte/reactivity";
import {
  type ChannelId, type ConsoleModel, type EqParam, type EqSchema, type EqSettings, type Key, type Value,
  EQ_SCHEMAS, channelParamKey, channelWriteKeys, eqRaw, eqWriteKeys, readEq, sendKey, sendWriteKeys, snapEq,
} from "../../shared/rcp.ts";

export interface ServerInfo {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  reason?: string;
  host: string;
  port: number;
  product?: string;
  firmware?: string;
  model: string;
  counts: ConsoleModel["counts"];
  scene?: number;
  eq: string | null;
  eqStatus: "unknown" | "probing" | "available" | "unavailable";
  meterStatus: "off" | "requested" | "active" | "unsupported";
  syncing: boolean;
  eqInputCount?: number;
  attempt?: number;
  delayMs?: number;
  pinRequired: boolean;
}

export interface LogEntry { t: number; d: string; s: string }

const SEND_INTERVAL = 30;

class Store {
  values = new SvelteMap<Key, Value>();
  info = $state<ServerInfo | null>(null);
  socket = $state<"connecting" | "open" | "closed">("connecting");
  needPin = $state(false);
  pinError = $state(false);
  meters = $state<Record<string, number[]>>({});
  log = $state<LogEntry[]>([]);

  private ws?: WebSocket;
  private touching = new Map<Key, number>();
  private outgoing = new Map<Key, Value>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private pin = localStorage.getItem("qlmix.pin") ?? "";

  get model(): ConsoleModel | null {
    return this.info ? { name: this.info.model, counts: this.info.counts } : null;
  }

  get connected(): boolean {
    return this.socket === "open" && this.info?.status === "connected" && !this.needPin;
  }

  get eqSchema(): EqSchema | null {
    const s = EQ_SCHEMAS.find((x) => x.name === this.info?.eq);
    return s ? { ...s, inputCount: this.info?.eqInputCount } : null;
  }

  // ------------------------------------------------------------ socket

  start(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.socket = "connecting";
    ws.onopen = () => (this.socket = "open");
    ws.onclose = () => {
      this.socket = "closed";
      setTimeout(() => this.start(), 1500);
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
  }

  private receive(m: any): void {
    switch (m.t) {
      case "hello":
        this.needPin = m.pinRequired;
        if (m.pinRequired && this.pin) this.sendRaw({ t: "auth", pin: this.pin });
        break;
      case "authOk":
        this.needPin = false;
        this.pinError = false;
        localStorage.setItem("qlmix.pin", this.pin);
        break;
      case "authFail":
        this.needPin = true;
        this.pinError = true;
        break;
      case "info": {
        const { t: _t, ...info } = m;
        this.info = info;
        break;
      }
      case "snapshot":
        this.values.clear();
        for (const [k, v] of Object.entries(m.values)) this.values.set(k, v as Value);
        break;
      case "p":
        for (const [k, v] of m.u as [Key, Value][]) {
          if (this.isTouching(k) || this.outgoing.has(k)) continue;
          if (this.values.get(k) !== v) this.values.set(k, v);
        }
        break;
      case "m":
        this.meters = m.m;
        break;
      case "log":
        this.log = m.entries;
        break;
    }
  }

  private sendRaw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  login(pin: string): void {
    this.pin = pin;
    this.sendRaw({ t: "auth", pin });
  }

  // ------------------------------------------------------------ values

  get(k: Key): Value | undefined {
    return this.values.get(k);
  }

  num(k: Key): number | undefined {
    const v = this.values.get(k);
    return typeof v === "number" ? v : undefined;
  }

  /** Writes a value to one or more wire keys (coalesced, latest wins). */
  write(keys: Key[], v: Value, immediate = false): void {
    for (const k of keys) {
      this.values.set(k, v);
      this.outgoing.set(k, v);
    }
    if (immediate) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), SEND_INTERVAL);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.outgoing.size === 0) return;
    this.sendRaw({ t: "set", u: [...this.outgoing] });
    this.outgoing.clear();
  }

  touch(keys: Key[], active: boolean): void {
    if (active) {
      for (const k of keys) this.touching.set(k, Infinity);
    } else {
      this.flush();
      // Ignore echoes for a moment so in-flight updates don't snap the control back.
      const until = Date.now() + 300;
      for (const k of keys) this.touching.set(k, until);
    }
  }

  private isTouching(k: Key): boolean {
    const until = this.touching.get(k);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.touching.delete(k);
    return false;
  }

  // ------------------------------------------------------------ helpers for channels

  level(c: ChannelId, mix: number | null): number | undefined {
    return this.num(mix === null ? channelParamKey(c, "level") : sendKey(c, mix, "level"));
  }

  isOn(c: ChannelId, mix: number | null): boolean {
    return (this.num(mix === null ? channelParamKey(c, "on") : sendKey(c, mix, "on")) ?? 1) !== 0;
  }

  levelKeys(c: ChannelId, mix: number | null): Key[] {
    return mix === null ? channelWriteKeys(c, "level") : sendWriteKeys(c, mix, "level");
  }

  onKeys(c: ChannelId, mix: number | null): Key[] {
    return mix === null ? channelWriteKeys(c, "on") : sendWriteKeys(c, mix, "on");
  }

  name(c: ChannelId): string {
    const v = this.get(channelParamKey(c, "name"));
    return typeof v === "string" ? v : "";
  }

  eq(c: ChannelId): EqSettings | null {
    const s = this.eqSchema;
    return s ? readEq((k) => this.values.get(k), c, s) : null;
  }

  writeEq(c: ChannelId, eq: EqSettings, params: EqParam[], immediate = false): void {
    const s = this.eqSchema;
    if (!s) return;
    const snapped = snapEq(eq, s);
    for (const p of params) this.write(eqWriteKeys(c, p, s), eqRaw(snapped, p, s), immediate);
  }

  /** Tells the server which channel's EQ is open (it polls it for changes made elsewhere). */
  watchEq(c: ChannelId | null): void {
    this.sendRaw({ t: "eqwatch", ch: c });
  }

  eqKeys(c: ChannelId, params: EqParam[]): Key[] {
    const s = this.eqSchema;
    return s ? params.flatMap((p) => eqWriteKeys(c, p, s)) : [];
  }

  // ------------------------------------------------------------ commands

  recall(n: number): void { this.sendRaw({ t: "recall", n }); }
  resync(): void { this.sendRaw({ t: "resync" }); }
  connectConsole(host: string): void { this.sendRaw({ t: "connect", host }); }
  disconnectConsole(): void { this.sendRaw({ t: "disconnect" }); }
  requestLog(): void { this.sendRaw({ t: "log" }); }
}

export const store = new Store();
