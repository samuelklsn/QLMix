// QLMix Web server: bridges browsers (WebSocket) to the Yamaha console (RCP over TCP).
//
//   node server/main.ts [--console 192.168.0.128] [--http-port 8080] [--pin 1234]
//
// Settings are persisted in web/config.json.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import { ConsoleLink } from "./console-link.ts";
import { QLLink } from "./ql-link.ts";
import { type ChannelId, type Key, type Kind, type Value, KINDS, PREFIX } from "../shared/rcp.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CONFIG_FILE = path.join(ROOT, "config.json");

// ---------------------------------------------------------------- config

interface Config {
  consoleHost: string;
  consolePort: number;
  httpPort: number;
  pin: string;
  autoConnect: boolean;
}

function loadConfig(): Config {
  const defaults: Config = { consoleHost: "192.168.0.128", consolePort: 49280, httpPort: 8080, pin: "", autoConnect: true };
  let cfg = defaults;
  try {
    cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch { /* first start */ }
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const next = () => args[++i] ?? "";
    switch (args[i]) {
      case "--console": cfg.consoleHost = next(); break;
      case "--console-port": cfg.consolePort = Number(next()); break;
      case "--http-port": case "--port": cfg.httpPort = Number(next()); break;
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
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
});

// ---------------------------------------------------------------- WebSocket

interface Client { ws: WebSocket; authed: boolean; eqWatch: ChannelId | null }

function updateWatched() {
  ql.setWatched([...clients].map((c) => c.eqWatch).filter((c): c is ChannelId => c !== null));
}
const clients = new Set<Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

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

wss.on("connection", (ws) => {
  const client: Client = { ws, authed: config.pin === "", eqWatch: null };
  clients.add(client);
  send(client, { t: "hello", pinRequired: !client.authed });
  if (client.authed) snapshot(client);

  ws.on("message", (data) => {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.t === "auth") {
      if (String(m.pin) === config.pin) { client.authed = true; send(client, { t: "authOk" }); snapshot(client); }
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
    }
  });
  ws.on("close", () => { clients.delete(client); updateWatched(); });
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
  broadcast(info());
});

const meters = new Map<string, number[]>();
let meterTimer: NodeJS.Timeout | undefined;
link.on("meter", (kind: string, values: number[]) => {
  meters.set(kind, values);
  meterTimer ??= setTimeout(() => {
    meterTimer = undefined;
    broadcast({ t: "m", m: Object.fromEntries(meters) });
  }, 80);
});
link.on("info", () => broadcast(info()));

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
  console.log(`  Pult:            ${config.consoleHost}:${config.consolePort}\n`);
  if (urls[0]) {
    console.log("  Mit dem Handy scannen:\n");
    qrcode.generate(urls[0], { small: true }, (q: string) => console.log(q.replace(/^/gm, "  ")));
  }
  if (!fs.existsSync(path.join(DIST, "index.html"))) console.log("  ⚠ Web-Oberfläche fehlt – bitte `npm run build` ausführen.\n");
  if (config.autoConnect && config.consoleHost) link.connect(config.consoleHost, config.consolePort);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${config.httpPort} ist belegt. Anderen Port wählen: --http-port 8081` : err);
  process.exit(1);
});

process.on("SIGINT", () => { ql.disconnect(); link.disconnect(); process.exit(0); });
