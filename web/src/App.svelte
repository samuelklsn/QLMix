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
  import Icon from "./lib/Icon.svelte";

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
  let height = $state(800);

  $effect(() => {
    if (lockedMix !== null) return; // musician links don't change the saved view
    localStorage.setItem("qlmix.mode", mode);
    localStorage.setItem("qlmix.mix", String(mix));
    localStorage.setItem("qlmix.bank", bank);
  });

  const model = $derived(store.model);
  const wide = $derived(width >= 720);
  // iPad / desktop: the channel panel sits next to the mixer (like the console's Selected Channel) instead of covering it.
  const dockable = $derived(width >= 1000 && height >= 600);
  const isSel = (c: ChannelId) => sheet !== null && sheet.kind === c.kind && sheet.index === c.index;
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

<svelte:window bind:innerWidth={width} bind:innerHeight={height} />

<div class="app">
  <header class="toolbar">
    <button class="status" onclick={() => { if (lockedMix === null) settings = true; }} aria-label="Verbindung: {statusText}">
      <span class="dot {statusClass}"></span>
      <span class="statustext">{statusText}</span>
      {#if store.info?.scene !== undefined}
        <span class="scene num">Szene {String(store.info.scene).padStart(3, "0")}</span>
      {/if}
      {#if store.info?.syncing}<span class="sync">lädt …</span>{/if}
    </button>

    {#if lockedMix === null && wide}
      <div class="segmented modes" role="tablist" aria-label="Ansicht">
        <button role="tab" aria-selected={mode === "main"} class:sel={mode === "main"} onclick={() => (mode = "main")}>Mischen</button>
        <button role="tab" aria-selected={mode === "monitor"} class:sel={mode === "monitor"} onclick={() => (mode = "monitor")}>Monitor</button>
      </div>
    {/if}

    <div class="tools">
      {#if lockedMix === null}
        <button class="tool" class:auto-on={store.auto?.status.enabled} onclick={() => (autoOpen = true)} aria-label="Raum-Automatik">
          <Icon name="wave" size={16} /><span>Auto</span>
        </button>
        {#if store.eqSchema?.kind === "ql"}
          <button class="tool" onclick={() => (rack = true)} aria-label="Premium Rack"><Icon name="rack" size={16} /><span>Rack</span></button>
        {/if}
        <button class="icon-btn" onclick={() => (settings = true)} aria-label="Einstellungen"><Icon name="gear" /></button>
      {/if}
    </div>
  </header>

  {#if lockedMix === null && !wide}
    <div class="row">
      <div class="segmented" role="tablist" aria-label="Ansicht">
        <button role="tab" aria-selected={mode === "main"} class:sel={mode === "main"} onclick={() => (mode = "main")}>Mischen</button>
        <button role="tab" aria-selected={mode === "monitor"} class:sel={mode === "monitor"} onclick={() => (mode = "monitor")}>Monitor</button>
      </div>
    </div>
  {/if}

  {#if mode === "monitor" && model}
    <div class="chips" role="tablist" aria-label="Monitormix">
      {#if lockedMix !== null}
        <span class="locked"><Icon name="lock" size={14} /> Dein Mix <b>{mixName(mix)}</b></span>
      {:else}
        {#each Array.from({ length: model.counts.mix }, (_, i) => i) as i}
          <button class="chip send" role="tab" aria-selected={mix === i} class:sel={mix === i} onclick={() => (mix = i)}>{mixName(i)}</button>
        {/each}
      {/if}
    </div>
  {/if}

  <div class="chips" role="tablist" aria-label="Kanalbank">
    {#each banks as b (b.id)}
      <button class="chip" role="tab" aria-selected={current?.id === b.id} class:sel={current?.id === b.id} onclick={() => (bank = b.id)}>{b.label}</button>
    {/each}
  </div>

  <div class="workspace">
  <main class="mixer" class:dim={!store.connected}>
    <div class="strips" bind:this={scroller}>
      {#if current}
        {#each current.channels as c (channelKey(c))}
          <Strip channel={c} mix={c.kind === "input" || c.kind === "stereoInput" ? mixMode : null} onopen={openSheet} selected={dockable && isSel(c)} />
        {/each}
      {/if}
    </div>
    {#if masters.length}
      <div class="masters">
        {#each masters as c (channelKey(c))}
          <Strip channel={c} master onopen={openSheet} selected={dockable && isSel(c)} />
        {/each}
      </div>
    {/if}
  </main>
  {#if sheet && dockable}
    <ChannelSheet docked channel={sheet} channels={allForSheet} onclose={() => (sheet = null)} onselect={(c) => (sheet = c)} />
  {/if}
  </div>

  {#if !model}
    <div class="empty">
      <span class="dot {statusClass}"></span>
      <p>{store.socket === "open" ? "Warte auf Pult …" : "Verbinde mit QLMix-Server …"}</p>
    </div>
  {:else if store.socket === "open" && store.info && store.info.status !== "connected"}
    <button class="banner" onclick={() => { if (lockedMix === null) settings = true; }}>
      <span class="banner-icon"><Icon name="warning" size={18} /></span>
      <span class="banner-text">
        <b>{store.info.status === "reconnecting" || store.info.status === "connecting" ? "Verbinde mit Pult …" : "Pult nicht verbunden"}</b>
        <span>{store.info.reason ?? `Pult-IP ${store.info.host}`}</span>
      </span>
      {#if lockedMix === null}<span class="banner-go"><Icon name="forward" size={16} /></span>{/if}
    </button>
  {/if}
</div>

{#if sheet && !dockable}
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
      <span class="pin-icon"><Icon name="lock" size={28} /></span>
      <h1 class="t-title">QLMix</h1>
      <p class="t-footnote">Bitte die PIN eingeben, um das Pult zu steuern.</p>
      <input type="password" inputmode="numeric" bind:value={pin} autocomplete="off" aria-label="PIN" />
      {#if store.pinError}<p class="err">Die PIN stimmt nicht.</p>{/if}
      <button class="pill primary big" type="submit">Weiter</button>
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

  /* toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--s3);
    min-height: 56px;
    padding: var(--s2) var(--s4);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
    flex: 1;
    text-align: left;
    padding: var(--s2) 0;
  }
  .statustext {
    font-size: var(--fs-headline);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scene {
    font-size: var(--fs-footnote);
    color: var(--label-2);
    white-space: nowrap;
    padding-left: var(--s2);
    border-left: 1px solid var(--hairline);
    margin-left: var(--s1);
  }
  .sync { font-size: var(--fs-footnote); color: var(--label-3); }
  .modes { width: 240px; flex: none; }
  .tools { display: flex; align-items: center; gap: var(--s2); flex: none; }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-compact);
    padding: 0 var(--s3);
    border-radius: var(--r-full);
    background: var(--surface-2);
    color: var(--label);
    font-size: var(--fs-footnote);
    font-weight: 600;
    transition: background-color 120ms var(--ease);
  }
  .tool:hover { background: var(--surface-3); }
  .tool :global(svg) { color: var(--label-2); }
  .tool.auto-on { background: var(--on); color: var(--on-ink); }
  .tool.auto-on :global(svg) { color: var(--on-ink); }
  /* Phones: icon-only tool buttons, so the console name stays readable. */
  @media (max-width: 430px) {
    .tool { width: var(--h-compact); padding: 0; justify-content: center; }
    .tool span { display: none; }
  }

  .row { padding: 0 var(--s4) var(--s2); }

  /* chips */
  .chips {
    display: flex;
    gap: var(--s2);
    padding: 0 var(--s4) var(--s3);
    overflow-x: auto;
    scrollbar-width: none;
    flex: none;
  }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: none;
    min-height: var(--h-compact);
    padding: 0 var(--s4);
    border-radius: var(--r-full);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    color: var(--label-2);
    font-size: var(--fs-footnote);
    font-weight: 600;
    white-space: nowrap;
    transition: background-color 120ms var(--ease), color 120ms;
  }
  .chip:hover { color: var(--label); }
  .chip.sel { background: var(--label); color: #0b0c0f; box-shadow: none; }
  .chip.send.sel { background: var(--send); color: var(--send-ink); }
  .locked { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-callout); color: var(--label-2); min-height: var(--h-compact); }
  .locked b { color: var(--send); }

  /* mixer + docked channel panel */
  .workspace { flex: 1; min-height: 0; display: flex; gap: var(--s2); padding: 0 var(--s2) var(--s2) 0; }
  .mixer { flex: 1; min-width: 0; min-height: 0; display: flex; gap: var(--strip-gap); padding: 0 0 0 var(--s2); }
  .mixer.dim { filter: saturate(0.4); pointer-events: none; }
  .strips {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: var(--strip-gap);
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x proximity;
    overscroll-behavior-x: contain;
    padding: 0 var(--s2) 2px;
    scrollbar-width: thin;
    scrollbar-color: var(--surface-3) transparent;
  }
  .masters {
    display: flex;
    gap: var(--strip-gap);
    padding-left: var(--s2);
    margin-left: var(--s1);
    box-shadow: inset 1px 0 0 var(--separator);
  }

  .empty {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s2);
    color: var(--label-2);
    font-size: var(--fs-callout);
    pointer-events: none;
  }

  /* connection banner */
  .banner {
    position: fixed;
    left: 50%;
    translate: -50% 0;
    bottom: calc(var(--s5) + env(safe-area-inset-bottom));
    width: min(440px, calc(100% - 2 * var(--s4)));
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-radius: var(--r-md);
    background: rgba(28, 31, 38, 0.92);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), inset 0 0 0 0.5px var(--hairline);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    text-align: left;
    z-index: 10;
  }
  .banner-icon { color: var(--warn); display: grid; }
  .banner-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .banner-text b { font-size: var(--fs-callout); }
  .banner-text span { font-size: var(--fs-footnote); color: var(--label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .banner-go { color: var(--label-3); display: grid; }

  /* PIN */
  .pin { position: fixed; inset: 0; z-index: 40; background: var(--bg); display: grid; place-items: center; padding: var(--s6); }
  .pin form { display: flex; flex-direction: column; align-items: center; gap: var(--s3); width: min(320px, 100%); text-align: center; }
  .pin-icon { width: 56px; height: 56px; border-radius: var(--r-md); background: var(--surface-2); display: grid; place-items: center; color: var(--label-2); margin-bottom: var(--s2); }
  .pin input { width: 100%; text-align: center; font-size: 24px; letter-spacing: 0.4em; margin-top: var(--s2); }
  .pin .pill { width: 100%; margin-top: var(--s2); }
  .err { color: var(--danger-text); font-size: var(--fs-footnote); }
</style>
