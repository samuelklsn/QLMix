// QLMix Web server: bridges browsers (WebSocket) to the Yamaha console (RCP over TCP).
//
//   node server/main.ts [--console 192.168.0.128] [--http-port 8080] [--pin 1234]
//
// Settings are persisted in web/config.json.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import { ConsoleLink } from "./console-link.ts";
import { QLLink } from "./ql-link.ts";
import { AutoLevel, type AutoConfig, DEFAULT_AUTO_CONFIG } from "./autolevel.ts";
import { ensureTls } from "./tls.ts";
import { CUSTOM_FADER_ELEMENTS } from "../shared/ql-params.ts";
import {
  type ChannelId, type Key, type Kind, type Value, KINDS, PREFIX, channelLabel, channelParamKey, channelWriteKeys,
} from "../shared/rcp.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const CONFIG_FILE = path.join(ROOT, "config.json");

// ---------------------------------------------------------------- config

interface Config {
  consoleHost: string;
  consolePort: number;
  httpPort: number;
  httpsPort: number;
  pin: string;
  autoConnect: boolean;
  autolevel: AutoConfig;
}

function loadConfig(): Config {
  const defaults: Config = {
    consoleHost: "192.168.0.128", consolePort: 49280, httpPort: 8080, httpsPort: 8443, pin: "", autoConnect: true,
    autolevel: { ...DEFAULT_AUTO_CONFIG },
  };
  let cfg = defaults;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg = { ...defaults, ...saved, autolevel: { ...DEFAULT_AUTO_CONFIG, ...(saved.autolevel ?? {}) } };
  } catch { /* first start */ }
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const next = () => args[++i] ?? "";
    switch (args[i]) {
      case "--console": cfg.consoleHost = next(); break;
      case "--console-port": cfg.consolePort = Number(next()); break;
      case "--http-port": case "--port": cfg.httpPort = Number(next()); break;
      case "--https-port": cfg.httpsPort = Number(next()); break;
      case "--pin": cfg.pin = next(); break;
      case "--no-connect": cfg.autoConnect = false; break;
      case "--help": case "-h":
        console.log("node server/main.ts [--console IP] [--console-port 49280] [--http-port 8080] [--pin PIN] [--no-connect]");
        process.exit(0);
    }
  }
  return cfg;
}

const config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
saveConfig();

// ---------------------------------------------------------------- console

const link = new ConsoleLink();
link.port = config.consolePort;
link.host = config.consoleHost;

// CL/QL: EQ/HPF via the editor protocol (TCP 50000), started once the console is identified.
const ql = new QLLink();
link.on("info", () => {
  const s = link.summary();
  const isClQl = !!s.product && /^(QL|CL)/i.test(s.product);
  if (s.status === "connected" && isClQl && !s.eq) ql.connect(s.host, { name: s.model, counts: s.counts });
  else if (s.status !== "connected" && s.status !== "reconnecting") ql.disconnect();
});

const logBuffer: { t: number; d: string; s: string }[] = [];
link.on("log", (d: string, s: string) => {
  logBuffer.push({ t: Date.now(), d, s });
  if (logBuffer.length > 500) logBuffer.shift();
  if (d === "info") console.log(`[Pult] ${s}`);
});

// ---------------------------------------------------------------- HTTP (static files)

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon",
};

const CERT_DIR = path.join(ROOT, "certs");
let tls: ReturnType<typeof ensureTls> | null = null;
try {
  tls = ensureTls(CERT_DIR);
} catch (err) {
  console.error("HTTPS-Zertifikat konnte nicht erstellt werden:", err);
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/qlmix-ca.crt" && tls) {
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": "attachment; filename=\"QLMix-Zertifikat.crt\"",
    });
    return res.end(tls.caCert);
  }
  if (url.pathname === "/api/endpoints") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ httpPort: config.httpPort, httpsPort: tls ? config.httpsPort : null }));
  }
  if (url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    const { t: _t, ...status } = info();
    return res.end(JSON.stringify(status));
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Web-Oberfläche noch nicht gebaut. Bitte im Ordner web/ ausführen:  npm run build");
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(handler);
const secureServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : null;

// ---------------------------------------------------------------- WebSocket

interface Client { ws: WebSocket; authed: boolean; eqWatch: ChannelId | null; rackWatch: number | null }

function updateWatched() {
  ql.setWatched([...clients].map((c) => c.eqWatch).filter((c): c is ChannelId => c !== null));
  ql.setWatchedRacks([...clients].map((c) => c.rackWatch).filter((r): r is number => r !== null));
}
const clients = new Set<Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function upgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
}
server.on("upgrade", upgrade);
secureServer?.on("upgrade", upgrade);

const send = (c: Client, msg: unknown) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg)); };
const broadcast = (msg: unknown) => { const s = JSON.stringify(msg); for (const c of clients) if (c.authed && c.ws.readyState === c.ws.OPEN) c.ws.send(s); };
function info() {
  const s = link.summary();
  let eq = s.eq, eqStatus = s.eqStatus;
  if (!eq && ql.status !== "off") {
    eq = ql.available ? "QL" : null;
    eqStatus = ql.available ? "available" : ql.status === "failed" ? "unavailable" : "probing";
  }
  return { t: "info", ...s, eq, eqStatus, eqInputCount: s.counts.input, pinRequired: config.pin !== "" };
}

function snapshot(c: Client) {
  send(c, info());
  send(c, { t: "snapshot", values: { ...Object.fromEntries(link.values), ...Object.fromEntries(ql.values) } });
}

/** Only parameters the UI is meant to change may be written by clients. */
const WRITABLE = /^MIXER:Current\/(?:(?:InCh|StInCh|Mix|Mtrx|St|DCA)\/(?:Fader\/Level|Fader\/On|Label\/Name|Label\/Color|ToMix\/Level|ToMix\/On|Port\/HA\/Gain|PEQ\/.+|EQ\/.+|HPF\/(?:On|Freq))|Cue\/(?:InCh|StInCh|Mix|Mtrx|St|DCA)\/On)$/;

// ---------------------------------------------------------------- Raum-Automatik

const auto = new AutoLevel({
  now: () => Date.now(),
  fader: (c) => { const v = link.values.get(channelParamKey(c, "level")); return typeof v === "number" ? v : undefined; },
  isOn: (c) => link.values.get(channelParamKey(c, "on")) === 1,
  setFader: (c, raw) => { for (const k of channelWriteKeys(c, "level")) { link.set(k, raw); queueParam(k, raw); } },
  setOn: (c, on) => { for (const k of channelWriteKeys(c, "on")) { link.set(k, on ? 1 : 0); queueParam(k, on ? 1 : 0); } },
  label: (c) => { const n = link.values.get(channelParamKey(c, "name")); return typeof n === "string" && n ? n : channelLabel(c); },
}, config.autolevel);
let roomClient: Client | null = null;
auto.onActiveChange = (label) => { if (auto.enabled) console.log(`[Auto] aktives Mikro: ${label ?? "keins"}`); };
auto.onEvent = (text) => console.log(`[Auto] ${text}`);
// Learned fader positions are saved a few seconds after they change (not on every tick).
let learnSave: ReturnType<typeof setTimeout> | undefined;
auto.onConfigChange = () => { clearTimeout(learnSave); learnSave = setTimeout(saveAuto, 5000); };
ql.on("inmeters", (levels: Map<string, number>) => {
  auto.setMeters(levels);
  // RCP only meters MIX/MTX on CL/QL – input strips get the editor-protocol input meters (pre-EQ).
  const input: number[] = [], stereo: number[] = [];
  for (const [k, v] of levels) {
    const [kind, i] = k.split(":");
    if (kind === "input") input[Number(i)] = v;
    else if (kind === "stereoInput") stereo[Number(i)] = v;
  }
  pushMeters("input", input);
  pushMeters("stereoInput", stereo);
});

const autoState = () => ({ t: "auto", config: auto.config, status: auto.getStatus(), measuring: roomClient !== null });
let lastAuto = "";
setInterval(() => {
  auto.tick();
  const msg = JSON.stringify(autoState());
  if (msg !== lastAuto || auto.enabled) { lastAuto = msg; for (const c of clients) if (c.authed && c.ws.readyState === c.ws.OPEN) c.ws.send(msg); }
}, 250);

function saveAuto() {
  config.autolevel = auto.config;
  saveConfig();
}

function handleAuto(client: Client, m: any) {
  let error: string | null = null;
  switch (m.action) {
    case "start": error = auto.start(); if (!error) console.log("[Auto] Raum-Automatik gestartet"); break;
    case "stop": auto.stop(); console.log("[Auto] Raum-Automatik gestoppt"); break;
    case "reference": error = auto.takeReference(); saveAuto(); break;
    case "forget": auto.config.learned = {}; saveAuto(); break;
    case "config": {
      const c = m.config ?? {};
      const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
      if (Array.isArray(c.channels)) {
        auto.config.channels = c.channels
          .filter((x: any) => (x?.kind === "input" || x?.kind === "stereoInput") && Number.isInteger(x?.index))
          .map((x: any) => ({ kind: x.kind, index: x.index }));
      }
      auto.config.offset = num(c.offset, -15, 15, auto.config.offset);
      auto.config.speed = num(c.speed, 0.2, 4, auto.config.speed);
      auto.config.ceiling = num(c.ceiling, -10, 10, auto.config.ceiling);
      auto.config.minLevel = num(c.minLevel, -60, auto.config.ceiling, auto.config.minLevel);
      auto.config.startLevel = num(c.startLevel, -40, 10, auto.config.startLevel);
      auto.config.closeAfter = num(c.closeAfter, 5, 600, auto.config.closeAfter);
      saveAuto();
      break;
    }
  }
  send(client, { t: "autoresult", action: m.action, error });
  broadcast(autoState());
}

wss.on("connection", (ws) => {
  const client: Client = { ws, authed: config.pin === "", eqWatch: null, rackWatch: null };
  clients.add(client);
  send(client, { t: "hello", pinRequired: !client.authed });
  if (client.authed) { snapshot(client); send(client, autoState()); }

  ws.on("message", (data) => {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.t === "auth") {
      if (String(m.pin) === config.pin) { client.authed = true; send(client, { t: "authOk" }); snapshot(client); send(client, autoState()); }
      else send(client, { t: "authFail" });
      return;
    }
    if (!client.authed) return;
    switch (m.t) {
      case "set":
        for (const [k, v] of (Array.isArray(m.u) ? m.u : []) as [Key, Value][]) {
          if (typeof k === "string" && k.startsWith("QL:")) {
            if (typeof v === "number" && ql.set(k, v)) queueParam(k, v, client);
            continue;
          }
          const address = typeof k === "string" ? k.split(" ")[0] : "";
          if (!address.startsWith(PREFIX) || !WRITABLE.test(address)) continue;
          if (typeof v !== "number" && typeof v !== "string") continue;
          link.set(k, typeof v === "string" ? v.slice(0, 8) : v);
          queueParam(k, v, client);
        }
        break;
      case "eqwatch": {
        const kind = m.ch?.kind as Kind;
        client.eqWatch = KINDS.includes(kind) && Number.isInteger(m.ch?.index) ? { kind, index: m.ch.index } : null;
        updateWatched();
        break;
      }
      case "room":
        if (typeof m.level === "number") {
          roomClient = client;
          auto.addRoomSample(m.level, m.feedback === true);
        }
        break;
      case "auto": handleAuto(client, m); break;
      case "rackwatch":
        client.rackWatch = Number.isInteger(m.rack) ? m.rack : null;
        updateWatched();
        break;
      case "recall": link.recallScene(Number(m.n)); break;
      case "resync": link.resync(); break;
      case "connect":
        if (typeof m.host === "string" && m.host.trim()) {
          config.consoleHost = m.host.trim();
          saveConfig();
        }
        link.connect(config.consoleHost, config.consolePort);
        break;
      case "disconnect": link.disconnect(); break;
      case "log": send(client, { t: "log", entries: logBuffer.slice(-200) }); break;
      case "probeFaderBanks": probeFaderBanks(client); break;
    }
  });
  ws.on("close", () => {
    clients.delete(client);
    if (roomClient === client) roomClient = null; // automatic holds by itself when samples stop
    updateWatched();
  });
});

// Batched parameter broadcast (every 25 ms). The originating client gets its own changes
// back too – it ignores them while the user is touching the control.
let pending = new Map<Key, Value>();
let flushTimer: NodeJS.Timeout | undefined;
function queueParam(k: Key, v: Value, _origin?: Client) {
  pending.set(k, v);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    const u = [...pending];
    pending = new Map();
    broadcast({ t: "p", u });
  }, 25);
}
link.on("param", (k: Key, v: Value) => queueParam(k, v));
ql.on("param", (k: Key, v: Value) => queueParam(k, v));
ql.on("status", () => {
  if (ql.status === "connected") console.log("[Pult] EQ-Verbindung (Port 50000) aktiv");
  else if (meters.delete("input") || meters.delete("stereoInput")) pushMeters("stereoInput", []);
  broadcast(info());
});

const meters = new Map<string, number[]>();
let meterTimer: NodeJS.Timeout | undefined;
function pushMeters(kind: string, values: number[]): void {
  meters.set(kind, values);
  meterTimer ??= setTimeout(() => {
    meterTimer = undefined;
    broadcast({ t: "m", m: Object.fromEntries(meters) });
  }, 80);
}
link.on("meter", (kind: string, values: number[]) => pushMeters(kind, values));
link.on("info", () => broadcast(info()));

// ---------------------------------------------------------------- custom fader bank (diagnosis)

let probing = false;
async function probeFaderBanks(client: Client): Promise<void> {
  if (probing) return;
  if (!ql.available) { send(client, { t: "probe", error: "Keine Editor-Verbindung zum Pult (Port 50000)." }); return; }
  probing = true;
  console.log("[Pult] Lese Fader-Ebenen (Custom Fader Bank) …");
  try {
    const elems = CUSTOM_FADER_ELEMENTS.map((e) => e.elem);
    const rows = await ql.probe(elems);
    const name = (n: number) => CUSTOM_FADER_ELEMENTS.find((e) => e.elem === n)?.name ?? String(n);
    const lines = [`QLMix ${VERSION} · ${link.summary().product ?? "?"} ${link.summary().firmware ?? ""} · ${new Date().toISOString()}`, `Antworten: ${rows.length}`];
    for (const e of CUSTOM_FADER_ELEMENTS) {
      const r = rows.filter((x) => x.elem === e.elem);
      lines.push("", `# ${e.elem} ${e.name} (${r.length} Werte)`);
      // one line per index: "idx: ch=value ch=value …" (only non-zero values, to stay readable)
      const byIdx = new Map<number, string[]>();
      for (const x of r) if (x.value !== 0) (byIdx.get(x.index) ?? byIdx.set(x.index, []).get(x.index)!).push(`${x.ch}=${x.value}`);
      const indices = [...new Set(r.map((x) => x.index))];
      lines.push(`  Indizes: ${indices.join(",") || "–"} · Kanäle: ${[...new Set(r.map((x) => x.ch))].join(",") || "–"}`);
      for (const [i, vals] of byIdx) lines.push(`  ${i}: ${vals.join(" ")}`);
    }
    const text = lines.join("\n");
    fs.writeFileSync(path.join(ROOT, "faderbank-probe.txt"), text + "\n");
    console.log(`[Pult] Fader-Ebenen gelesen: ${rows.length} Werte → faderbank-probe.txt`);
    send(client, { t: "probe", text, count: rows.length, name: rows.length ? name(rows[0].elem) : "" });
  } catch (err) {
    send(client, { t: "probe", error: String(err) });
  } finally {
    probing = false;
  }
}

// ---------------------------------------------------------------- start

server.listen(config.httpPort, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  const urls = ips.map((ip) => `http://${ip}:${config.httpPort}`);
  console.log("\n  QLMix Web läuft.\n");
  console.log(`  Auf diesem Mac:  http://localhost:${config.httpPort}`);
  for (const u of urls) console.log(`  Im Netzwerk:     ${u}`);
  if (config.pin) console.log(`  PIN:             ${config.pin}`);
  if (secureServer) console.log(`  Mit Mikrofon (Raum-Automatik): https://<IP>:${config.httpsPort}  ·  Zertifikat: http://<IP>:${config.httpPort}/qlmix-ca.crt`);
  console.log(`  Pult:            ${config.consoleHost}:${config.consolePort}\n`);
  if (urls[0]) {
    console.log("  Mit dem Handy scannen:\n");
    qrcode.generate(urls[0], { small: true }, (q: string) => console.log(q.replace(/^/gm, "  ")));
  }
  if (!fs.existsSync(path.join(DIST, "index.html"))) console.log("  ⚠ Web-Oberfläche fehlt – bitte `npm run build` ausführen.\n");
  if (config.autoConnect && config.consoleHost) link.connect(config.consoleHost, config.consolePort);
});

secureServer?.listen(config.httpsPort, "0.0.0.0");
secureServer?.on("error", (err: NodeJS.ErrnoException) => console.error(`HTTPS-Port ${config.httpsPort}:`, err.code ?? err.message));

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${config.httpPort} ist belegt. Anderen Port wählen: --http-port 8081` : err);
  process.exit(1);
});

process.on("SIGINT", () => { auto.stop(); ql.disconnect(); link.disconnect(); process.exit(0); });
