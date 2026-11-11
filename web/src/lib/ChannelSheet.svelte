<script lang="ts">
  import {
    type ChannelId, COLOR_HEX, GAIN_MAX, GAIN_MIN, LABEL_COLORS, channelLabel, channelParamKey, channelWriteKeys,
    darkTextColors, gainText, hasEQ, hasGain, normalizeColor,
  } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";
  import EqEditor from "./EqEditor.svelte";
  import DynamicsPanel from "./DynamicsPanel.svelte";
  import { dynaSlots } from "../../shared/ql-params.ts";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";
  import ChannelHead from "./ChannelHead.svelte";

  const COLOR_NAMES: Record<string, string> = {
    Blue: "Blau", Orange: "Orange", Yellow: "Gelb", Purple: "Lila", Cyan: "Cyan", Magenta: "Magenta", Red: "Rot", Green: "Grün", Off: "Keine Farbe",
  };

  interface Props {
    channel: ChannelId;
    channels: ChannelId[];
    onclose: () => void;
    onselect: (c: ChannelId) => void;
    /** side panel next to the mixer instead of a modal sheet */
    docked?: boolean;
  }
  let { channel, channels, onclose, onselect, docked = false }: Props = $props();

  // Swipe left/right on the channel title to change channel.
  let swipeX: number | null = null;
  const swipeStart = (e: PointerEvent) => { swipeX = e.clientX; };
  const swipeEnd = (e: PointerEvent) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  };

  let chosenTab = $state<"eq" | "dyna" | "channel">("eq");
  const withDyna = $derived(store.eqSchema?.kind === "ql" && dynaSlots(channel.kind) > 0);
  const tab = $derived(
    chosenTab === "eq" && !hasEQ(channel.kind) ? (withDyna ? "dyna" : "channel") : chosenTab === "dyna" && !withDyna ? "channel" : chosenTab,
  );
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

<Sheet title="Kanal {channelLabel(channel)}" {onclose} {docked} width={docked ? 460 : 640}>
  {#snippet header()}
    <div class="chhead">
      <button class="icon-btn" onclick={() => step(-1)} aria-label="Vorheriger Kanal"><Icon name="back" /></button>
      <div class="chtitle" onpointerdown={swipeStart} onpointerup={swipeEnd} onpointercancel={() => (swipeX = null)} role="presentation">
        <span class="chnum">{channelLabel(channel)}</span>
        <span class="chname" style="background: {COLOR_HEX[color]}; color: {darkTextColors.includes(color) ? '#111' : '#fff'}">{name || channelLabel(channel)}</span>
      </div>
      <button class="icon-btn" onclick={() => step(1)} aria-label="Nächster Kanal"><Icon name="forward" /></button>
    </div>
  {/snippet}

  <ChannelHead {channel} />

  {#if hasEQ(channel.kind) || withDyna}
    <div class="segmented" role="tablist" aria-label="Bereich">
      {#if hasEQ(channel.kind)}<button role="tab" aria-selected={tab === "eq"} class:sel={tab === "eq"} onclick={() => (chosenTab = "eq")}>EQ</button>{/if}
      {#if withDyna}<button role="tab" aria-selected={tab === "dyna"} class:sel={tab === "dyna"} onclick={() => (chosenTab = "dyna")}>Dynamics</button>{/if}
      <button role="tab" aria-selected={tab === "channel"} class:sel={tab === "channel"} onclick={() => (chosenTab = "channel")}>Kanal</button>
    </div>
  {/if}

  {#if tab === "dyna"}
    <DynamicsPanel {channel} />
  {:else if tab === "eq"}
    {#if store.eqSchema}
      <EqEditor {channel} />
    {:else if store.info?.eqStatus === "probing" || store.info?.eqStatus === "unknown"}
      <p class="t-footnote">Verbinde EQ-Steuerung …</p>
    {:else}
      <div class="group">
        <b class="t-headline">EQ-Verbindung zum Pult nicht möglich</b>
        <p class="t-footnote">Die EQ-Steuerung nutzt Port 50000 des Pults – wie QL Editor und StageMix. Läuft der QL Editor auf demselben Rechner wie der QLMix-Server, bitte den Editor schließen.</p>
      </div>
    {/if}
  {:else}
    <section>
      <h3 class="section-title">Name und Farbe</h3>
      <div class="group">
        <form onsubmit={(e) => { e.preventDefault(); rename(); }}>
          <input type="text" maxlength="8" bind:value={nameInput} onblur={rename} placeholder="Name (max. 8 Zeichen)" autocomplete="off" aria-label="Kanalname" />
        </form>
        <div class="colors" role="radiogroup" aria-label="Kanalfarbe">
          {#each LABEL_COLORS as c}
            <button class="color" class:sel={c === color} style="background: {COLOR_HEX[c]}; color: {darkTextColors.includes(c) ? '#111' : '#fff'}"
              role="radio" aria-checked={c === color} aria-label={COLOR_NAMES[c] ?? c}
              onclick={() => store.write(channelWriteKeys(channel, "color"), c, true)}>
              {#if c === color}<Icon name="check" size={16} />{/if}
            </button>
          {/each}
        </div>
      </div>
    </section>

    {#if hasGain(channel.kind)}
      <section>
        <h3 class="section-title">Gain (Vorverstärker)</h3>
        <div class="group">
          <div class="gainrow">
            <span class="gainval num">{gainText(gain)}</span>
            <button class="pill" onclick={() => setGain((gain ?? 0) - 100)} aria-label="Gain −1 dB">−1</button>
            <button class="pill" onclick={() => setGain((gain ?? 0) + 100)} aria-label="Gain +1 dB">+1</button>
          </div>
          <input type="range" min={GAIN_MIN} max={GAIN_MAX} step="100" value={gain ?? 0} aria-label="Gain"
            onpointerdown={() => store.touch(channelWriteKeys(channel, "gain"), true)}
            onpointerup={() => store.touch(channelWriteKeys(channel, "gain"), false)}
            oninput={(e) => setGain(+e.currentTarget.value)} />
          <p class="t-footnote">Gain wirkt auch auf alle Monitormixe.</p>
        </div>
      </section>
    {/if}
  {/if}
</Sheet>

<style>
  .chhead { display: flex; align-items: center; gap: var(--s3); }
  .chtitle { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; touch-action: pan-y; }
  .chnum { font-size: var(--fs-caption); font-weight: 600; color: var(--label-2); letter-spacing: 0.02em; }
  .chname {
    padding: 4px 12px;
    border-radius: var(--r-xs);
    font: 700 var(--fs-headline) / 22px var(--font);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  form input { width: 100%; }
  .colors { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: var(--s2); }
  .color {
    aspect-ratio: 1;
    min-height: 40px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.3);
    transition: transform 120ms var(--ease);
  }
  .color:active { transform: scale(0.94); }
  .color.sel { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--label); }
  .gainrow { display: flex; align-items: center; gap: var(--s2); }
  .gainval { flex: 1; font: 600 var(--fs-title) / 28px var(--font-display); }
</style>
