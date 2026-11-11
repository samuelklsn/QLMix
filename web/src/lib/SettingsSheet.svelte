<script lang="ts">
  import { channelId, channelParamKey } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";

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

  let copied = $state<number | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(i: number, text: string) {
    try { await navigator.clipboard.writeText(text); } catch { prompt("Link kopieren:", text); return; }
    copied = i;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), 1600);
  }
  let probeCopied = $state(false);
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); probeCopied = true; setTimeout(() => (probeCopied = false), 1600); }
    catch { prompt("Text kopieren:", text); }
  }
  const sceneText = $derived(info?.scene !== undefined ? String(info.scene).padStart(3, "0") : "–");
</script>

<Sheet title="Einstellungen" width={560} {onclose}>
  <section>
    <h3 class="section-title">Pult</h3>
    <div class="group">
      <div class="status">
        <span class="dot {info?.status ?? 'idle'}"></span>
        <span class="t-headline">{statusText}</span>
      </div>
      {#if info?.product}
        <p class="t-footnote">{info.product} · Firmware {info.firmware ?? "?"} · {info.counts.input} Kanäle</p>
      {/if}
      <form class="row" onsubmit={(e) => { e.preventDefault(); store.connectConsole(host); }}>
        <input type="text" inputmode="decimal" bind:value={host} placeholder="IP-Adresse, z. B. 192.168.0.128" autocomplete="off" aria-label="IP-Adresse des Pults" />
        <button class="pill primary big" type="submit">Verbinden</button>
      </form>
      <div class="row">
        <button class="pill" onclick={() => store.disconnectConsole()}>Trennen</button>
        <button class="pill" onclick={() => store.resync()} disabled={!store.connected}>Neu laden</button>
      </div>
    </div>
    <p class="hint t-footnote">Die IP steht am QL unter SETUP → NETWORK. Port 49280.</p>
  </section>

  <section>
    <h3 class="section-title">Szene</h3>
    <div class="group">
      <div class="scene">
        <span class="t-footnote">Aktuell</span>
        <span class="scene-num num">{sceneText}</span>
      </div>
      <form class="row" onsubmit={(e) => { e.preventDefault(); recall(); }}>
        <input type="number" inputmode="numeric" min="0" max="300" bind:value={scene} placeholder="Szenennummer" aria-label="Szenennummer" />
        <button class="pill big" type="submit" disabled={!store.connected || scene === ""}>Aufrufen</button>
      </form>
      {#if confirmScene !== null}
        <div class="confirm" role="alert">
          <p class="t-callout">Szene <b>{confirmScene}</b> aufrufen? Der aktuelle Mix am Pult wird überschrieben.</p>
          <div class="row">
            <button class="pill" onclick={() => (confirmScene = null)}>Abbrechen</button>
            <button class="pill danger" onclick={() => { store.recall(confirmScene!); confirmScene = null; }}>Szene aufrufen</button>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <section>
    <h3 class="section-title">Links für Musiker</h3>
    <div class="links">
      {#each mixes as i}
        <button class="link" onclick={() => copy(i, `${base}/?mix=${i + 1}`)} aria-label="Link für {mixName(i)} kopieren">
          <span class="link-name">{mixName(i)}</span>
          <span class="link-path">{#if copied === i}<Icon name="check" size={13} /> Kopiert{:else}/?mix={i + 1}{/if}</span>
        </button>
      {/each}
    </div>
    <p class="hint t-footnote">Antippen kopiert den Link. Er öffnet nur den Monitormix dieses Busses – ideal fürs Handy des Musikers.</p>
  </section>

  <section>
    <h3 class="section-title">Diagnose</h3>
    <div class="group">
      <dl class="diag">
        <dt>Meter</dt>
        <dd>{info?.meterStatus === "active" ? "Aktiv" : info?.meterStatus === "unsupported" ? "Nicht unterstützt" : "Warte …"}</dd>
        <dt>EQ</dt>
        <dd>{info?.eqStatus === "available" ? `Verfügbar (${info.eq})` : info?.eqStatus === "unavailable" ? "Vom Pult nicht freigegeben" : "Prüfe …"}</dd>
      </dl>
      <div class="row">
        <button class="pill" onclick={() => (showLog = !showLog)}>{showLog ? "Log ausblenden" : "Log anzeigen"}</button>
        <button class="pill" class:lit={store.rawMode} aria-pressed={store.rawMode} onclick={() => store.setRawMode(!store.rawMode)}>Rohwerte {store.rawMode ? "an" : "aus"}</button>
      </div>
      <button class="pill" onclick={() => store.probeFaderBanks()} disabled={!store.connected || store.probe.running}>
        {store.probe.running ? "Lese Fader-Ebenen …" : "Fader-Ebenen vom Pult lesen"}
      </button>
      {#if store.probe.error}<p class="err t-footnote" role="alert">{store.probe.error}</p>{/if}
      {#if store.probe.text}
        <div class="probe">
          <div class="probe-head">
            <span class="t-footnote">{store.probe.count} Werte gelesen – bitte als Screenshot oder kopiert schicken.</span>
            <button class="pill" onclick={() => copyText(store.probe.text!)}>{probeCopied ? "Kopiert" : "Kopieren"}</button>
          </div>
          <pre class="log">{store.probe.text}</pre>
        </div>
      {/if}
      {#if showLog}
        <pre class="log">{store.log.map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.d === "tx" ? "→" : e.d === "rx" ? "←" : "•"} ${e.s}`).join("\n")}</pre>
      {/if}
    </div>
  </section>
</Sheet>

<style>
  .row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
  .row input { flex: 1; min-width: 160px; }
  .status { display: flex; align-items: center; gap: var(--s2); }
  .hint { padding: var(--s2) var(--s1) 0; }
  .scene { display: flex; align-items: baseline; justify-content: space-between; }
  .scene-num { font: 600 var(--fs-title) / 28px var(--font-display); color: var(--info); }
  .confirm {
    display: flex; flex-direction: column; gap: var(--s3);
    padding: var(--s3);
    border-radius: var(--r-sm);
    background: rgba(255, 69, 58, 0.1);
    box-shadow: inset 0 0 0 1px rgba(255, 69, 58, 0.35);
  }
  .confirm .row { justify-content: flex-end; }
  .links { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s2); }
  .link {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    min-height: 56px; padding: var(--s2) var(--s3);
    border-radius: var(--r-sm);
    background: var(--surface-1);
    text-align: left;
    transition: background-color 120ms var(--ease);
  }
  .link:hover { background: var(--surface-2); }
  .link-name { font-size: var(--fs-callout); font-weight: 600; }
  .link-path { display: inline-flex; align-items: center; gap: 4px; font: var(--fs-caption) / 16px var(--font-mono); color: var(--label-2); }
  .diag { display: grid; grid-template-columns: auto 1fr; gap: var(--s1) var(--s4); margin: 0; font-size: var(--fs-callout); }
  .diag dt { color: var(--label-2); }
  .diag dd { margin: 0; text-align: right; }
  .err { color: var(--danger-text); }
  .probe { display: flex; flex-direction: column; gap: var(--s2); }
  .probe-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
  .log {
    max-height: 240px; overflow: auto; margin: 0;
    font: 11px / 1.5 var(--font-mono); color: var(--label-2);
    background: var(--sunken); padding: var(--s3); border-radius: var(--r-xs);
    white-space: pre-wrap; word-break: break-all;
    -webkit-user-select: text; user-select: text;
  }
</style>
