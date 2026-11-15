// Puts the room mic(s) on free receive channels of this PC's Dante Virtual Soundcard – by itself.
//
// 1. Find the Dante devices: our own soundcard (its address is one of this PC's) and the console.
// 2. Read (only read!) where the console's Dante inputs come from, e.g. "03@Rio3224-…".
// 3. Subscribe free receive channels of OUR soundcard to the most likely sources (the console
//    input with the room mic's number first), up to 4 at a time.
// 4. Compare the sound on those channels with the room mic's console meter. Keep the one that
//    matches, remove the others, try the next candidates if none matches.
// Only subscriptions QLMix made itself are ever removed again (they are remembered).

import type { DanteDevice, RxChannel, Subscription } from "./dante-control.ts";

export interface DanteRoute { rx: number; txChannel: string; txDevice: string; mic: string; label: string }

export interface RouterStatus {
  state: "idle" | "searching" | "testing" | "done" | "error";
  message: string;
  routes: DanteRoute[];
}

export interface RouterIO {
  discover(): Promise<DanteDevice[]>;
  localIps(): string[];
  readRx(dev: DanteDevice): Promise<RxChannel[]>;
  add(dev: DanteDevice, subs: Subscription[]): Promise<void>;
  remove(dev: DanteDevice, rx: number[]): Promise<void>;
  /** room mics: console input key ("input:22") and label ("CH 23 Raum") */
  roomMics(): { key: string; index: number; label: string }[];
  /** level correlation of our receive channel `rx` with console input `key` since `since` (ms), null = not enough data yet */
  correlate(rx: number, key: string, since: number): number | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  routes(): DanteRoute[];
  saveRoutes(routes: DanteRoute[]): void;
  log(text: string): void;
}

const BATCH = 4;
const MAX_ROUNDS = 8;
const TEST_MS = 45000;
const POLL_MS = 3000;
const SETTLE_MS = 2000;
const MATCH_CORR = 0.8;

export class DanteRouter {
  status: RouterStatus = { state: "idle", message: "", routes: [] };
  private busy = false;
  private io: RouterIO;

  constructor(io: RouterIO) {
    this.io = io;
    this.status.routes = io.routes();
  }

  private set(state: RouterStatus["state"], message: string): void {
    this.status = { state, message, routes: this.io.routes() };
    this.io.log(message);
  }

  /** Finds our soundcard and the console in the Dante network. */
  private async devices(): Promise<{ own: DanteDevice; consoleDev: DanteDevice }> {
    const devices = await this.io.discover();
    const ips = new Set(this.io.localIps());
    const own = devices.find((d) => ips.has(d.host));
    if (!own) throw new Error("Die Dante Virtual Soundcard dieses PCs wurde im Dante-Netz nicht gefunden. Läuft sie?");
    const others = devices.filter((d) => d !== own);
    const consoleDev = others.find((d) => /(^|[^a-z])(QL|CL)\d?/i.test(d.name));
    if (!consoleDev) throw new Error(`Das Pult wurde im Dante-Netz nicht gefunden (gefunden: ${others.map((d) => d.name).join(", ") || "nichts"}).`);
    return { own, consoleDev };
  }

  async autoRoute(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const mics = this.io.roomMics();
      if (!mics.length) throw new Error("Bitte zuerst unter „1 Raum-Mikrofone“ die Raum-Mikros auswählen.");
      this.set("searching", "Suche die Dante-Geräte …");
      const { own, consoleDev } = await this.devices();
      const ownRx = await this.io.readRx(own);
      const done = new Set(this.io.routes().filter((r) => ownRx.some((c) => c.number === r.rx && c.txChannel === r.txChannel && c.txDevice === r.txDevice)).map((r) => r.mic));
      // Free = no subscription at all. From the top down – the low channels are what other programs use first.
      const free = ownRx.filter((c) => !c.txChannel).map((c) => c.number).sort((a, b) => b - a);
      const sources = new Map<string, { num: number; txChannel: string; txDevice: string }>();
      for (const c of await this.io.readRx(consoleDev)) {
        if (!c.txChannel) continue;
        const txDevice = !c.txDevice || c.txDevice === "." ? consoleDev.name : c.txDevice;
        const id = `${c.txChannel}@${txDevice}`;
        if (!sources.has(id)) sources.set(id, { num: c.number, txChannel: c.txChannel, txDevice });
      }
      if (!sources.size) throw new Error(`${consoleDev.name}: keine Dante-Eingänge belegt.`);

      const found: DanteRoute[] = [];
      for (const mic of mics.filter((m) => !done.has(m.key))) {
        if (!free.length) throw new Error("Auf der Dante-Soundkarte ist kein freier Empfangskanal mehr.");
        // The console input with the room mic's number first (default patch), then its neighbours.
        const order = [...sources.values()].sort((a, b) => Math.abs(a.num - (mic.index + 1)) - Math.abs(b.num - (mic.index + 1)));
        let route: DanteRoute | null = null;
        for (let round = 0; round < MAX_ROUNDS && !route && order.length; round++) {
          const batch = order.splice(0, Math.min(BATCH, free.length));
          const subs = batch.map((s, i) => ({ rx: free[i], txChannel: s.txChannel, txDevice: s.txDevice }));
          await this.io.add(own, subs);
          try {
            const since = this.io.now() + SETTLE_MS;
            this.set("testing", `${mic.label}: prüfe ${subs.map((s) => `${s.txChannel}@${s.txDevice}`).join(", ")} – bitte jetzt normal in ein Mikro sprechen …`);
            const end = this.io.now() + TEST_MS;
            while (!route && this.io.now() < end) {
              await this.io.sleep(POLL_MS);
              for (const s of subs) {
                const c = this.io.correlate(s.rx, mic.key, since);
                if (c !== null && c >= MATCH_CORR) { route = { ...s, mic: mic.key, label: mic.label }; break; }
              }
            }
          } finally {
            // Test subscriptions that did not match are always taken away again – also on errors.
            const unused = subs.filter((s) => s.rx !== route?.rx).map((s) => s.rx);
            if (unused.length) await this.io.remove(own, unused);
          }
          if (route) {
            free.splice(free.indexOf(route.rx), 1);
            found.push(route);
            this.io.saveRoutes([...this.io.routes(), route]);
          }
        }
        if (!route) throw new Error(`${mic.label} wurde auf keinem Dante-Eingang gefunden. Bitte während der Suche in ein Mikro sprechen und noch einmal versuchen.`);
      }
      this.set("done", found.length
        ? `Fertig: ${found.map((r) => `${r.label} liegt jetzt auf Dante-Kanal ${r.rx}`).join(", ")}.`
        : "Die Raum-Mikros liegen schon auf der Dante-Soundkarte.");
    } catch (e) {
      this.set("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }

  /** Removes exactly the subscriptions QLMix made (if they are still what QLMix set). */
  async removeAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const routes = this.io.routes();
      if (routes.length) {
        const { own } = await this.devices();
        const ownRx = await this.io.readRx(own);
        const mine = routes.filter((r) => ownRx.some((c) => c.number === r.rx && c.txChannel === r.txChannel && c.txDevice === r.txDevice));
        if (mine.length) await this.io.remove(own, mine.map((r) => r.rx));
      }
      this.io.saveRoutes([]);
      this.set("idle", "Zuweisungen von QLMix entfernt.");
    } catch (e) {
      this.set("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }
}
