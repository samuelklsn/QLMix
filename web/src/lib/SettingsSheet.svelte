<script lang="ts">
  import { channelId, channelParamKey } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";

  let { onclose }: { onclose: () => void } = $props();

  let host = $state(store.info?.host ?? "");
  let scene = $state("");
  let confirmScene = $state<number | null>(null);
  let showLog = $state(false);

  const info = $derived(store.info);
  const statusText = $derived.by(() => {
    if (store.socket !== "open") return "Keine Verbindung zum QLMix-Server";
    switch (info?.status) {
      case "connected": return "Mit Pult verbunden";
      case "connecting": return "Verbinde mit Pult …";
      case "reconnecting": return `${info.reason ?? "Verbindung verloren"} – neuer Versuch …`;
      case "failed": return info.reason ?? "Verbindung fehlgeschlagen";
      default: return "Getrennt";
    }
  });
  const mixes = $derived(Array.from({ length: info?.counts.mix ?? 0 }, (_, i) => i));
  const base = `${location.protocol}//${location.host}`;

  function mixName(i: number) {
    const v = store.get(channelParamKey(channelId("mix", i), "name"));
    return typeof v === "string" && v ? v : `MIX ${i + 1}`;
  }

  function recall() {
    const n = Number(scene);
    if (Number.isInteger(n) && n >= 0 && n <= 300) confirmScene = n;
  }

  $effect(() => {
    if (!showLog) return;
    store.requestLog();
    const t = setInterval(() => store.requestLog(), 2000);
    return () => clearInterval(t);
  });

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); } catch { prompt("Link kopieren:", text); }
  }
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-label="Einstellungen">
  <header>
    <h2>Einstellungen</h2>
    <button class="icon" onclick={onclose} aria-label="Schließen">✕</button>
  </header>
  <div class="body">
    <section>
      <h3>Pult</h3>
      <div class="status">
        <span class="dot {info?.status ?? 'idle'}"></span>
        <span>{statusText}</span>
      </div>
      {#if info?.product}
        <p class="small">{info.product} · Firmware {info.firmware ?? "?"} · {info.counts.input} Kanäle</p>
      {/if}
      <form class="row" onsubmit={(e) => { e.preventDefault(); store.connectConsole(host); }}>
        <input type="text" inputmode="decimal" bind:value={host} placeholder="IP-Adresse, z. B. 192.168.0.128" autocomplete="off" />
        <button class="pill lit" type="submit">Verbinden</button>
      </form>
      <div class="row">
        <button class="pill" onclick={() => store.disconnectConsole()}>Trennen</button>
        <button class="pill" onclick={() => store.resync()} disabled={!store.connected}>Neu laden</button>
      </div>
      <p class="small">IP des Pults: am QL unter SETUP → NETWORK. Port 49280.</p>
    </section>

    <section>
      <h3>Szene <b>{info?.scene !== undefined ? String(info.scene).padStart(3, "0") : "–"}</b></h3>
      <form class="row" onsubmit={(e) => { e.preventDefault(); recall(); }}>
        <input type="number" inputmode="numeric" min="0" max="300" bind:value={scene} placeholder="Nummer" />
        <button class="pill" type="submit" disabled={!store.connected || scene === ""}>Aufrufen</button>
      </form>
      {#if confirmScene !== null}
        <div class="confirm">
          <p>Szene <b>{confirmScene}</b> aufrufen? Der aktuelle Mix am Pult wird überschrieben.</p>
          <div class="row">
            <button class="pill danger" onclick={() => { store.recall(confirmScene!); confirmScene = null; }}>Aufrufen</button>
            <button class="pill" onclick={() => (confirmScene = null)}>Abbrechen</button>
          </div>
        </div>
      {/if}
    </section>

    <section>
      <h3>Links für Musiker</h3>
      <p class="small">Jeder Link öffnet nur den Monitormix dieses Busses – ideal fürs Handy des Musikers.</p>
      <div class="links">
        {#each mixes as i}
          <button class="link" onclick={() => copy(`${base}/?mix=${i + 1}`)}>
            <span>{mixName(i)}</span><code>/?mix={i + 1}</code>
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h3>Diagnose</h3>
      <p class="small">
        Meter: {info?.meterStatus === "active" ? "aktiv" : info?.meterStatus === "unsupported" ? "nicht unterstützt" : "warte …"} ·
        EQ: {info?.eqStatus === "available" ? `verfügbar (${info.eq})` : info?.eqStatus === "unavailable" ? "vom Pult nicht freigegeben" : "prüfe …"}
      </p>
      <button class="pill" onclick={() => (showLog = !showLog)}>{showLog ? "Log ausblenden" : "Log anzeigen"}</button>
      {#if showLog}
        <pre class="log">{store.log.map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.d === "tx" ? "→" : e.d === "rx" ? "←" : "•"} ${e.s}`).join("\n")}</pre>
      {/if}
    </section>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 20; }
  .sheet {
    position: fixed; z-index: 21; left: 50%; bottom: 0; translate: -50% 0;
    width: min(560px, 100%); max-height: 92dvh; display: flex; flex-direction: column;
    background: #15181d; border-radius: 18px 18px 0 0; border: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: env(safe-area-inset-bottom);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 4px; }
  h2 { margin: 0; font-size: 18px; }
  .icon { width: 36px; height: 36px; border-radius: 10px; background: #23272e; }
  .body { overflow-y: auto; padding: 8px 14px 22px; }
  section { margin: 14px 0 20px; display: flex; flex-direction: column; gap: 10px; }
  h3 { margin: 0; font-size: 13px; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; }
  h3 b { color: #6fd8ff; font-variant-numeric: tabular-nums; }
  .row { display: flex; gap: 10px; align-items: center; }
  .row input { flex: 1; min-width: 0; }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .small { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
  .confirm { background: #2a1d10; border: 1px solid #ff9f0a55; border-radius: 10px; padding: 10px; }
  .confirm p { margin: 0 0 8px; font-size: 14px; }
  .links { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .link { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border-radius: 10px; background: #1f2329; text-align: left; }
  .link span { font-weight: 700; }
  .link code { font-size: 11px; color: var(--muted); }
  .log { max-height: 240px; overflow: auto; font-size: 10.5px; background: #0a0b0d; padding: 8px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
</style>
