// TCP connection to the Yamaha console (RCP, port 49280) with reconnect, keepalive,
// paced initial sync and a value cache that the web clients mirror.

import net from "node:net";
import { EventEmitter } from "node:events";
import {
  type ConsoleModel, type EqSchema, type Key, type Value,
  EQ_PARAMS, EQ_SCHEMAS, METER_SOURCES, MODELS,
  allChannels, canSend, channelId, channelParamKey, channelsOf, cmd, eqKey, hasEQ, hasGain,
  key, meterKind, modelFromProductName, parseLine, sendKey, splitKey,
} from "../shared/rcp.ts";

export type LinkStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface LinkSummary {
  status: LinkStatus;
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
}

const KEEPALIVE_MS = 3000;
const RX_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 5000;
const QUEUE_BATCH = 30;
const QUEUE_INTERVAL_MS = 15;

export class ConsoleLink extends EventEmitter {
  readonly values = new Map<Key, Value>();
  host = "";
  port = 49280;
  meterIntervalMs = 100;

  private status: LinkStatus = "idle";
  private reason?: string;
  private product?: string;
  private firmware?: string;
  private model: ConsoleModel = MODELS[0];
  private scene?: number;
  private eqSchema: EqSchema | null = null;
  private eqStatus: LinkSummary["eqStatus"] = "unknown";
  private meterStatus: LinkSummary["meterStatus"] = "off";
  private syncing = false;

  private socket?: net.Socket;
  private gen = 0;
  private wants = false;
  private attempt = 0;
  private buffer = "";
  private lastRx = 0;
  private queue: string[] = [];
  private queueTimer?: NodeJS.Timeout;
  private timers: NodeJS.Timeout[] = [];
  private awaitingModel = false;

  summary(): LinkSummary {
    return {
      status: this.status, reason: this.reason, host: this.host, port: this.port,
      product: this.product, firmware: this.firmware, model: this.model.name, counts: this.model.counts,
      scene: this.scene, eq: this.eqSchema?.name ?? null, eqStatus: this.eqStatus,
      meterStatus: this.meterStatus, syncing: this.syncing,
    };
  }

  // ------------------------------------------------------------ public API

  connect(host: string, port = 49280): void {
    this.teardown();
    this.host = host.trim();
    this.port = port;
    this.wants = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wants = false;
    this.teardown();
    this.setStatus("idle");
  }

  /** Writes a value (user action). Sent immediately, ahead of the sync queue. */
  set(k: Key, v: Value): void {
    if (this.status !== "connected") return;
    const { address, x, y } = splitKey(k);
    this.values.set(k, v);
    this.write([cmd.set(address, x, y, v)]);
  }

  recallScene(n: number): void {
    if (this.status === "connected" && Number.isInteger(n) && n >= 0 && n <= 300) this.write([cmd.sceneRecall(n)]);
  }

  resync(): void {
    if (this.status === "connected") this.fullSync();
  }

  // ------------------------------------------------------------ connection

  private open(): void {
    const gen = ++this.gen;
    this.buffer = "";
    this.setStatus("connecting");
    this.log("info", `Verbinde mit ${this.host}:${this.port} …`);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setEncoding("utf8");

    this.timer(() => {
      if (gen === this.gen && this.status === "connecting") this.lost(gen, "Zeitüberschreitung beim Verbindungsaufbau");
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      if (gen !== this.gen) return;
      this.attempt = 0;
      this.lastRx = Date.now();
      this.setStatus("connected");
      this.onConnected(gen);
    });
    socket.on("data", (chunk: string) => {
      if (gen !== this.gen) return;
      this.lastRx = Date.now();
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, "");
        this.buffer = this.buffer.slice(i + 1);
        if (line) this.handleLine(line);
      }
      if (this.buffer.length > 65536) this.buffer = "";
    });
    socket.on("error", (err: NodeJS.ErrnoException) => this.lost(gen, describeError(err)));
    socket.on("close", () => this.lost(gen, "Verbindung vom Pult geschlossen"));
  }

  private onConnected(gen: number): void {
    this.awaitingModel = true;
    this.eqSchema = null;
    this.write(["devinfo productname", "devinfo version"]);
    this.probeEq();
    this.timer(() => {
      if (gen === this.gen && this.awaitingModel) {
        this.awaitingModel = false;
        this.fullSync();
      }
    }, 1500);
    this.startMeters();
    const keepalive = setInterval(() => {
      if (gen !== this.gen) return clearInterval(keepalive);
      if (Date.now() - this.lastRx > RX_TIMEOUT_MS) return this.lost(gen, "Keine Antwort vom Pult (Timeout)");
      this.write(["devstatus runmode"], true);
    }, KEEPALIVE_MS);
    this.timers.push(keepalive);
  }

  private lost(gen: number, reason: string): void {
    if (gen !== this.gen) return;
    this.teardown();
    this.reason = reason;
    this.log("info", reason);
    if (!this.wants) return this.setStatus("failed");
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 10000);
    this.setStatus("reconnecting");
    this.emit("info", { ...this.summary(), attempt: this.attempt, delayMs: delay });
    const expected = this.gen;
    this.timer(() => {
      if (this.wants && expected === this.gen) this.open();
    }, delay);
  }

  private teardown(): void {
    this.gen += 1;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = undefined;
    this.queue = [];
    this.syncing = false;
    this.awaitingModel = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on("error", () => {});
      this.socket.destroy();
      this.socket = undefined;
    }
    if (this.eqStatus === "probing") this.eqStatus = "unknown";
    if (this.meterStatus !== "unsupported") this.meterStatus = "off";
  }

  private timer(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private setStatus(s: LinkStatus): void {
    if (s === "connected") this.reason = undefined;
    this.status = s;
    this.emit("info", this.summary());
  }

  // ------------------------------------------------------------ writing

  private write(lines: string[], quiet = false): void {
    if (!this.socket || this.status !== "connected" || lines.length === 0) return;
    this.socket.write(lines.join("\n") + "\n");
    if (!quiet) for (const l of lines) this.log("tx", l);
  }

  private enqueue(lines: string[]): void {
    this.queue.push(...lines);
    if (!this.queueTimer) this.pump();
  }

  private pump(): void {
    const batch = this.queue.splice(0, QUEUE_BATCH);
    if (batch.length === 0) {
      this.queueTimer = undefined;
      if (this.syncing) {
        this.syncing = false;
        this.emit("info", this.summary());
      }
      return;
    }
    this.write(batch, true);
    this.queueTimer = setTimeout(() => this.pump(), QUEUE_INTERVAL_MS);
  }

  // ------------------------------------------------------------ sync

  private fullSync(): void {
    this.syncing = true;
    this.emit("info", this.summary());
    const m = this.model;
    const lines: string[] = [cmd.sceneCurrent()];
    const get = (k: Key) => { const { address, x, y } = splitKey(k); lines.push(cmd.get(address, x, y)); };
    for (const c of allChannels(m)) {
      for (const p of ["level", "on", "name", "color", "cue"] as const) get(channelParamKey(c, p));
      if (hasGain(c.kind)) get(channelParamKey(c, "gain"));
    }
    const sources = [...channelsOf(m, "input"), ...channelsOf(m, "stereoInput")];
    for (let mix = 0; mix < m.counts.mix; mix++) {
      for (const c of sources) if (canSend(c.kind)) { get(sendKey(c, mix, "level")); get(sendKey(c, mix, "on")); }
    }
    this.enqueue(lines);
    if (this.eqSchema) this.syncEq();
  }

  private probeEq(): void {
    this.eqStatus = "probing";
    const c = channelId("input", 0);
    this.write(EQ_SCHEMAS.map((s) => { const { address, x, y } = splitKey(eqKey(c, { p: "on" }, s)); return cmd.get(address, x, y); }));
    const gen = this.gen;
    this.timer(() => {
      if (gen === this.gen && this.eqStatus === "probing") {
        this.eqStatus = "unavailable";
        this.log("info", "Pult beantwortet keine EQ-Befehle über RCP");
        this.emit("info", this.summary());
      }
    }, 4000);
  }

  private syncEq(): void {
    const s = this.eqSchema;
    if (!s) return;
    const lines: string[] = [];
    for (const c of allChannels(this.model)) {
      if (!hasEQ(c.kind)) continue;
      for (const e of EQ_PARAMS) { const { address, x, y } = splitKey(eqKey(c, e, s)); lines.push(cmd.get(address, x, y)); }
    }
    this.enqueue(lines);
  }

  private startMeters(): void {
    if (this.meterStatus === "unsupported") return;
    this.meterStatus = "requested";
    this.write(METER_SOURCES.map((s) => cmd.meterStart(s.address, this.meterIntervalMs)));
  }

  // ------------------------------------------------------------ incoming

  private handleLine(line: string): void {
    const msg = parseLine(line);
    if (msg.kind !== "meter" && !line.startsWith("OK devstatus runmode")) this.log("rx", line);

    switch (msg.kind) {
      case "param": {
        if (this.eqStatus === "probing" && msg.x === 0) {
          const schema = EQ_SCHEMAS.find((s) => eqKey(channelId("input", 0), { p: "on" }, s) === key(msg.address, 0, 0));
          if (schema) {
            this.eqSchema = schema;
            this.eqStatus = "available";
            this.log("info", `EQ verfügbar (Schema ${schema.name})`);
            this.emit("info", this.summary());
            if (!this.awaitingModel) this.syncEq();
          }
        }
        const k = key(msg.address, msg.x, msg.y);
        this.values.set(k, msg.value);
        this.emit("param", k, msg.value);
        break;
      }
      case "meter": {
        const kind = meterKind(msg.address);
        if (!kind) break;
        if (this.meterStatus !== "active") {
          this.meterStatus = "active";
          this.emit("info", this.summary());
        }
        this.emit("meter", kind, msg.values);
        break;
      }
      case "scene": {
        const changed = this.scene !== msg.number;
        this.scene = msg.number;
        this.emit("info", this.summary());
        if (msg.status === "NOTIFY" || (msg.command.startsWith("ssrecall") && msg.status === "OK")) {
          if (changed || msg.command.startsWith("ssrecall")) {
            this.log("info", `Szene ${msg.number} aufgerufen – synchronisiere …`);
            this.fullSync();
          }
        }
        break;
      }
      case "info": {
        if (msg.command === "devinfo" && msg.args[0] === "productname" && msg.args[1]) {
          this.product = msg.args[1].trim();
          this.model = modelFromProductName(msg.args[1]);
          this.emit("info", this.summary());
          if (this.awaitingModel) {
            this.awaitingModel = false;
            this.fullSync();
          }
        } else if (msg.command === "devinfo" && msg.args[0] === "version" && msg.args[1]) {
          this.firmware = msg.args[1].trim();
          this.emit("info", this.summary());
        }
        break;
      }
      case "error":
        if (msg.command === "mtrstart") {
          this.meterStatus = "unsupported";
          this.emit("info", this.summary());
        }
        break;
    }
  }

  private log(dir: "tx" | "rx" | "info", text: string): void {
    this.emit("log", dir, text);
  }
}

function describeError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "ECONNREFUSED": return "Verbindung abgelehnt (Port geschlossen?)";
    case "EHOSTUNREACH":
    case "ENETUNREACH": return "Pult nicht erreichbar (Netzwerk/IP prüfen)";
    case "ETIMEDOUT": return "Zeitüberschreitung";
    case "ECONNRESET": return "Verbindung zurückgesetzt";
    case "ENOTFOUND": return "Adresse unbekannt";
    default: return `Netzwerkfehler: ${err.message}`;
  }
}
