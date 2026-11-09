<script lang="ts">
  import {
    type ChannelId, type Kind, channelId, channelKey, channelLabel, channelParamKey, channelsOf,
  } from "../shared/rcp.ts";
  import { store } from "./lib/store.svelte.ts";
  import Strip from "./lib/Strip.svelte";
  import ChannelSheet from "./lib/ChannelSheet.svelte";
  import SettingsSheet from "./lib/SettingsSheet.svelte";
  import RackSheet from "./lib/RackSheet.svelte";
  import AutoSheet from "./lib/AutoSheet.svelte";

  // ?mix=3 → locked to monitor mix 3 (for musicians)
  const params = new URLSearchParams(location.search);
  const lockedMix = params.has("mix") ? Math.max(0, Number(params.get("mix")) - 1) : null;

  const saved = (k: string, d: string) => localStorage.getItem(`qlmix.${k}`) ?? d;
  let mode = $state<"main" | "monitor">(lockedMix !== null ? "monitor" : (saved("mode", "main") as "main" | "monitor"));
  let mix = $state(lockedMix ?? Number(saved("mix", "0")));
  let bank = $state(saved("bank", "input:0"));
  let sheet = $state<ChannelId | null>(null);
  let settings = $state(false);
  let rack = $state(false);
  let autoOpen = $state(new URLSearchParams(location.search).has("auto"));
  let pin = $state("");
  let width = $state(1000);

  $effect(() => {
    if (lockedMix !== null) return; // musician links don't change the saved view
    localStorage.setItem("qlmix.mode", mode);
    localStorage.setItem("qlmix.mix", String(mix));
    localStorage.setItem("qlmix.bank", bank);
  });

  const model = $derived(store.model);
  const wide = $derived(width >= 720);
  const mixMode = $derived(mode === "monitor" ? mix : null);

  interface Bank { id: string; label: string; channels: ChannelId[] }
  const banks = $derived.by((): Bank[] => {
    if (!model) return [];
    const out: Bank[] = [];
    const inputs = channelsOf(model, "input");
    const per = 16;
    for (let i = 0; i < inputs.length; i += per) {
      out.push({ id: `input:${i / per}`, label: `${i + 1}–${Math.min(i + per, inputs.length)}`, channels: inputs.slice(i, i + per) });
    }
    out.push({ id: "stereoInput", label: "ST IN", channels: channelsOf(model, "stereoInput") });
    if (mode === "main") {
      const kinds: [Kind, string][] = [["mix", "MIX"], ["matrix", "MTX"], ["dca", "DCA"]];
      for (const [k, label] of kinds) out.push({ id: k, label, channels: channelsOf(model, k) });
      if (!wide) out.push({ id: "main", label: "SUMME", channels: [channelId("stereo", 0), channelId("mono", 0)] });
    }
    return out;
  });

  const current = $derived(banks.find((b) => b.id === bank) ?? banks[0]);
  const masters = $derived.by((): ChannelId[] => {
    if (mode === "monitor") return [channelId("mix", mix)];
    return wide ? [channelId("stereo", 0), channelId("mono", 0)] : [];
  });
  const allForSheet = $derived(model ? [...channelsOf(model, "input"), ...channelsOf(model, "stereoInput"), ...channelsOf(model, "mix"), ...channelsOf(model, "matrix"), channelId("stereo", 0), channelId("mono", 0)] : []);

  // Musicians (locked to their mix) can't open channel settings (gain/EQ/names).
  const openSheet = $derived(lockedMix === null ? (ch: ChannelId) => (sheet = ch) : undefined);

  function mixName(i: number) {
    const v = store.get(channelParamKey(channelId("mix", i), "name"));
    return typeof v === "string" && v ? v : `MIX ${i + 1}`;
  }

  const statusClass = $derived(store.socket !== "open" ? "failed" : (store.info?.status ?? "idle"));
  const statusText = $derived.by(() => {
    if (store.socket !== "open") return "Server nicht erreichbar";
    const i = store.info;
    if (!i) return "…";
    switch (i.status) {
      case "connected": return i.product ?? "Verbunden";
      case "connecting": return "Verbinde …";
      case "reconnecting": return "Verbindung verloren …";
      case "failed": return i.reason ?? "Fehler";
      default: return "Getrennt";
    }
  });

  let scroller: HTMLDivElement | undefined = $state();
  $effect(() => {
    void current?.id;
    scroller?.scrollTo({ left: 0 });
  });
</script>

<svelte:window bind:innerWidth={width} />

<div class="app">
  <header class="top">
    <button class="status" onclick={() => { if (lockedMix === null) settings = true; }}>
      <span class="dot {statusClass}"></span>
      <span class="statustext">{statusText}</span>
      {#if store.info?.syncing}<span class="sync">lädt …</span>{/if}
    </button>
    <span class="spacer"></span>
    {#if store.info?.scene !== undefined}
      <span class="scene">Szene <b>{String(store.info.scene).padStart(3, "0")}</b></span>
    {/if}
    {#if lockedMix === null}
      <button class="icon rackbtn" class:autoon={store.auto?.status.enabled} onclick={() => (autoOpen = true)} aria-label="Raum-Automatik">Auto</button>
      {#if store.eqSchema?.kind === "ql"}
        <button class="icon rackbtn" onclick={() => (rack = true)} aria-label="Premium Rack">Rack</button>
      {/if}
      <button class="icon" onclick={() => (settings = true)} aria-label="Einstellungen">⚙︎</button>
    {/if}
  </header>

  {#if lockedMix === null}
    <nav class="modes">
      <button class:sel={mode === "main"} onclick={() => (mode = "main")}>Mischen</button>
      <button class:sel={mode === "monitor"} onclick={() => (mode = "monitor")}>Monitor</button>
    </nav>
  {/if}

  {#if mode === "monitor" && model}
    <div class="chips mixes">
      {#if lockedMix !== null}
        <span class="locked">Dein Mix: <b>{mixName(mix)}</b></span>
      {:else}
        {#each Array.from({ length: model.counts.mix }, (_, i) => i) as i}
          <button class="chip" class:sel={mix === i} onclick={() => (mix = i)}>{mixName(i)}</button>
        {/each}
      {/if}
    </div>
  {/if}

  <div class="chips banks">
    {#each banks as b (b.id)}
      <button class="chip" class:sel={current?.id === b.id} onclick={() => (bank = b.id)}>{b.label}</button>
    {/each}
  </div>

  <main class="mixer" class:dim={!store.connected}>
    <div class="strips" bind:this={scroller}>
      {#if current}
        {#each current.channels as c (channelKey(c))}
          <Strip channel={c} mix={c.kind === "input" || c.kind === "stereoInput" ? mixMode : null} onopen={openSheet} />
        {/each}
      {/if}
    </div>
    {#if masters.length}
      <div class="masters">
        {#each masters as c (channelKey(c))}
          <Strip channel={c} master onopen={openSheet} />
        {/each}
      </div>
    {/if}
  </main>

  {#if !model}
    <div class="empty">
      <p>{store.socket === "open" ? "Warte auf Pult …" : "Verbinde mit QLMix-Server …"}</p>
    </div>
  {:else if store.socket === "open" && store.info && store.info.status !== "connected"}
    <div class="banner" onclick={() => { if (lockedMix === null) settings = true; }} role="presentation">
      <b>{store.info.status === "reconnecting" || store.info.status === "connecting" ? "Verbinde mit Pult …" : "Pult nicht verbunden"}</b>
      <span>{store.info.reason ?? `Pult-IP: ${store.info.host}`} – tippen für Einstellungen</span>
    </div>
  {/if}
</div>

{#if sheet}
  <ChannelSheet channel={sheet} channels={allForSheet} onclose={() => (sheet = null)} onselect={(c) => (sheet = c)} />
{/if}
{#if settings}
  <SettingsSheet onclose={() => (settings = false)} />
{/if}
{#if rack}
  <RackSheet onclose={() => (rack = false)} />
{/if}
{#if autoOpen}
  <AutoSheet onclose={() => (autoOpen = false)} />
{/if}

{#if store.needPin}
  <div class="pin">
    <form onsubmit={(e) => { e.preventDefault(); store.login(pin); }}>
      <h2>QLMix</h2>
      <p>PIN eingeben</p>
      <input type="password" inputmode="numeric" bind:value={pin} autocomplete="off" />
      {#if store.pinError}<p class="err">Falsche PIN</p>{/if}
      <button class="pill lit" type="submit">Weiter</button>
    </form>
  </div>
{/if}

<style>
  .app {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .top { display: flex; align-items: center; gap: 10px; padding: 8px 12px 6px; }
  .status { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 600; font-size: 14px; }
  .statustext { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sync { font-size: 12px; color: var(--muted); font-weight: 500; }
  .spacer { flex: 1; }
  .scene { font-size: 13px; color: var(--muted); white-space: nowrap; }
  .scene b { color: #6fd8ff; font-variant-numeric: tabular-nums; font-size: 15px; }
  .icon { width: 38px; height: 38px; border-radius: 10px; background: #1d2026; font-size: 18px; }
  .icon.rackbtn { width: auto; padding: 0 10px; font-size: 13px; font-weight: 700; }
  .icon.rackbtn.autoon { background: #34c759; color: #06260f; }
  .modes { display: flex; margin: 2px 12px 6px; background: #0e1013; border-radius: 11px; padding: 3px; }
  .modes button { flex: 1; height: 34px; border-radius: 9px; font-weight: 700; color: var(--muted); }
  .modes button.sel { background: #2a2f37; color: var(--text); }
  .chips { display: flex; gap: 6px; padding: 2px 12px 8px; overflow-x: auto; scrollbar-width: none; flex: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: none; height: 32px; padding: 0 12px; border-radius: 16px; background: #1d2026;
    font-size: 13px; font-weight: 700; color: var(--muted); white-space: nowrap;
  }
  .chip.sel { background: #e8eaed; color: #111; }
  .mixes .chip.sel { background: #ff9f0a; color: #241400; }
  .locked { font-size: 14px; color: var(--muted); padding: 6px 0; }
  .locked b { color: #ff9f0a; }
  .mixer { flex: 1; min-height: 0; display: flex; gap: 6px; padding: 0 8px 8px; }
  .mixer.dim { opacity: 0.55; }
  .strips {
    flex: 1; min-width: 0; display: flex; gap: 5px; overflow-x: auto; overflow-y: hidden;
    scroll-snap-type: x proximity; overscroll-behavior-x: contain; padding-bottom: 2px;
  }
  .masters { display: flex; gap: 5px; padding-left: 6px; border-left: 1px solid rgba(255, 255, 255, 0.08); }
  .empty { position: fixed; inset: 0; display: grid; place-items: center; color: var(--muted); pointer-events: none; }
  .banner {
    position: fixed; left: 50%; translate: -50% 0; bottom: calc(18px + env(safe-area-inset-bottom));
    width: min(420px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 2px;
    padding: 12px 14px; border-radius: 14px; background: #2b1a14ee; border: 1px solid #ff6b3d55;
    font-size: 13px; backdrop-filter: blur(10px);
  }
  .banner span { color: var(--muted); }
  .pin { position: fixed; inset: 0; z-index: 40; background: #0d0f12; display: grid; place-items: center; }
  .pin form { display: flex; flex-direction: column; gap: 12px; width: min(280px, 80vw); text-align: center; }
  .pin h2 { margin: 0; }
  .pin p { margin: 0; color: var(--muted); }
  .pin .err { color: #ff453a; }
  .pin input { text-align: center; font-size: 22px; letter-spacing: 0.3em; }
</style>
