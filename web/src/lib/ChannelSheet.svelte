<script lang="ts">
  import {
    type ChannelId, COLOR_HEX, GAIN_MAX, GAIN_MIN, LABEL_COLORS, channelLabel, channelParamKey, channelWriteKeys,
    darkTextColors, gainText, hasEQ, hasGain, normalizeColor,
  } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";
  import EqEditor from "./EqEditor.svelte";

  interface Props {
    channel: ChannelId;
    channels: ChannelId[];
    onclose: () => void;
    onselect: (c: ChannelId) => void;
  }
  let { channel, channels, onclose, onselect }: Props = $props();

  let chosenTab = $state<"eq" | "channel">("eq");
  const tab = $derived(hasEQ(channel.kind) ? chosenTab : "channel");
  const color = $derived(normalizeColor(store.get(channelParamKey(channel, "color")) as string | undefined));
  const name = $derived(store.name(channel));
  const gain = $derived(store.num(channelParamKey(channel, "gain")));
  let nameInput = $state("");

  // Let the server poll this channel's EQ while the sheet is open (changes made at the console).
  $effect(() => {
    store.watchEq(channel);
    return () => store.watchEq(null);
  });
  $effect(() => { nameInput = name; });

  function step(delta: number) {
    const i = channels.findIndex((c) => c.kind === channel.kind && c.index === channel.index);
    if (i >= 0) onselect(channels[(i + delta + channels.length) % channels.length]);
  }
  function rename() {
    const n = nameInput.slice(0, 8);
    if (n !== name) store.write(channelWriteKeys(channel, "name"), n, true);
  }
  function setGain(raw: number) {
    store.write(channelWriteKeys(channel, "gain"), Math.round(Math.min(GAIN_MAX, Math.max(GAIN_MIN, raw)) / 100) * 100);
  }
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-label="Kanal {channelLabel(channel)}">
  <header>
    <button class="icon" onclick={() => step(-1)} aria-label="Vorheriger Kanal">‹</button>
    <div class="title">
      <span class="num">{channelLabel(channel)}</span>
      <span class="chip" style="background: {COLOR_HEX[color]}; color: {darkTextColors.includes(color) ? '#111' : '#fff'}">{name || channelLabel(channel)}</span>
    </div>
    <button class="icon" onclick={() => step(1)} aria-label="Nächster Kanal">›</button>
    <span class="spacer"></span>
    <button class="icon close" onclick={onclose} aria-label="Schließen">✕</button>
  </header>

  {#if hasEQ(channel.kind)}
    <div class="seg">
      <button class:sel={tab === "eq"} onclick={() => (chosenTab = "eq")}>EQ</button>
      <button class:sel={tab === "channel"} onclick={() => (chosenTab = "channel")}>Kanal</button>
    </div>
  {/if}

  <div class="body">
    {#if tab === "eq"}
      {#if store.eqSchema}
        <EqEditor {channel} />
      {:else if store.info?.eqStatus === "probing" || store.info?.eqStatus === "unknown"}
        <p class="note">Verbinde EQ-Steuerung …</p>
      {:else}
        <div class="note">
          <b>EQ-Verbindung zum Pult nicht möglich.</b>
          <p>Die EQ-Steuerung nutzt Port 50000 des Pults (wie QL Editor/StageMix). Läuft der QL Editor auf demselben Rechner wie der QLMix-Server, bitte den Editor schließen.</p>
        </div>
      {/if}
    {:else}
      <section>
        <h3>Name &amp; Farbe</h3>
        <form class="row" onsubmit={(e) => { e.preventDefault(); rename(); }}>
          <input type="text" maxlength="8" bind:value={nameInput} onblur={rename} placeholder="Name" autocomplete="off" />
        </form>
        <div class="colors">
          {#each LABEL_COLORS as c}
            <button class="color" class:sel={c === color} style="background: {COLOR_HEX[c]}" aria-label={c}
              onclick={() => store.write(channelWriteKeys(channel, "color"), c, true)}></button>
          {/each}
        </div>
      </section>

      {#if hasGain(channel.kind)}
        <section>
          <h3>Gain (Vorverstärker) <b>{gainText(gain)}</b></h3>
          <div class="row">
            <button class="pill" onclick={() => setGain((gain ?? 0) - 100)}>−1</button>
            <input type="range" min={GAIN_MIN} max={GAIN_MAX} step="100" value={gain ?? 0}
              onpointerdown={() => store.touch(channelWriteKeys(channel, "gain"), true)}
              onpointerup={() => store.touch(channelWriteKeys(channel, "gain"), false)}
              oninput={(e) => setGain(+e.currentTarget.value)} />
            <button class="pill" onclick={() => setGain((gain ?? 0) + 100)}>+1</button>
          </div>
          <p class="small">Vorsicht: Gain wirkt auch auf alle Monitormixe.</p>
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 20; }
  .sheet {
    position: fixed;
    z-index: 21;
    left: 50%;
    bottom: 0;
    translate: -50% 0;
    width: min(640px, 100%);
    max-height: 92dvh;
    display: flex;
    flex-direction: column;
    background: #15181d;
    border-radius: 18px 18px 0 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: env(safe-area-inset-bottom);
    animation: up 0.18s ease-out;
  }
  @keyframes up { from { transform: translateY(40px); opacity: 0; } }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
  .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .num { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .chip { padding: 4px 10px; border-radius: 6px; font-weight: 800; font-size: 15px; white-space: nowrap; }
  .spacer { flex: 1; }
  .icon { width: 36px; height: 36px; border-radius: 10px; background: #23272e; font-size: 20px; line-height: 1; }
  .close { font-size: 15px; }
  .seg { display: flex; margin: 0 12px; background: #0e1013; border-radius: 10px; padding: 3px; }
  .seg button { flex: 1; height: 32px; border-radius: 8px; font-weight: 700; color: var(--muted); }
  .seg button.sel { background: #2a2f37; color: var(--text); }
  .body { overflow-y: auto; padding: 12px 14px 18px; }
  section { margin-bottom: 18px; }
  h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; }
  h3 b { color: var(--text); }
  .row { display: flex; gap: 10px; align-items: center; }
  .row input[type="text"] { flex: 1; }
  .row input[type="range"] { flex: 1; }
  .colors { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .color { width: 36px; height: 36px; border-radius: 9px; border: 2px solid transparent; }
  .color.sel { border-color: #fff; }
  .note { color: var(--muted); font-size: 14px; line-height: 1.45; }
  .note b { color: var(--text); }
  .small { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
</style>
