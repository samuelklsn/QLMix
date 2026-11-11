<script lang="ts">
  import {
    type ChannelId, COLOR_HEX, channelLabel, channelParamKey, channelWriteKeys, darkTextColors, levelText, meterNorm,
    normalizeColor,
  } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";
  import Fader from "./Fader.svelte";

  interface Props {
    channel: ChannelId;
    /** null = channel fader, number = send to that mix */
    mix?: number | null;
    master?: boolean;
    onopen?: (c: ChannelId) => void;
    /** shown in the docked channel panel */
    selected?: boolean;
  }
  let { channel, mix = null, master = false, onopen, selected = false }: Props = $props();

  const sendMode = $derived(mix !== null);
  const level = $derived(store.level(channel, mix));
  const on = $derived(store.isOn(channel, mix));
  const cue = $derived((store.num(channelParamKey(channel, "cue")) ?? 0) !== 0);
  const name = $derived(store.name(channel) || channelLabel(channel));
  const color = $derived(normalizeColor(store.get(channelParamKey(channel, "color")) as string | undefined));
  const meter = $derived.by(() => {
    if (sendMode) return null;
    const raw = store.meters[channel.kind]?.[channel.index];
    return raw === undefined ? (channel.kind === "mix" || channel.kind === "matrix" ? 0 : null) : meterNorm(raw);
  });
  const enabled = $derived(store.connected);

  function setLevel(raw: number) {
    store.write(store.levelKeys(channel, mix), raw);
  }
  function toggleOn() {
    store.write(store.onKeys(channel, mix), on ? 0 : 1, true);
  }
  function toggleCue() {
    store.write(channelWriteKeys(channel, "cue"), cue ? 0 : 1, true);
  }
</script>

<div class="strip" class:send={sendMode} class:cue class:off={!on} class:master class:selected>
  <div class="num">{channelLabel(channel)}</div>
  <button class="name" style="background: {COLOR_HEX[color]}; color: {darkTextColors.includes(color) ? '#111' : '#fff'}"
    onclick={() => onopen?.(channel)} disabled={!enabled || !onopen} title={onopen ? `${name} – EQ, Dynamics, Gain` : name}>
    {name}
  </button>
  <div class="buttons">
    <button class="key on" class:lit={on} onclick={toggleOn} disabled={!enabled} aria-pressed={on} aria-label="{name} ON">ON</button>
    {#if !sendMode}
      <button class="key cuebtn" class:lit={cue} onclick={toggleCue} disabled={!enabled} aria-pressed={cue} aria-label="{name} CUE">CUE</button>
    {/if}
  </div>
  <div class="value" class:inf={level === undefined || level <= -13800}>{levelText(level)}</div>
  <div class="fader">
    <Fader
      value={level}
      accent={sendMode ? "#ff9f0a" : COLOR_HEX[color]}
      disabled={!enabled}
      {meter}
      label={sendMode ? `${name} Send` : `${name} Fader`}
      onchange={setLevel}
      ontouch={(a) => store.touch(store.levelKeys(channel, mix), a)}
    />
  </div>
</div>

<style>
  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    width: var(--strip-w);
    flex: none;
    padding: var(--s2) 6px var(--s2);
    border-radius: 12px;
    background: var(--strip-bg);
    box-shadow: inset 0 0 0 1px var(--separator);
    scroll-snap-align: start;
    transition: box-shadow 150ms var(--ease);
  }
  .strip.send { background: var(--strip-send-bg); }
  .strip.master { background: var(--strip-master-bg); }
  .strip.cue { box-shadow: inset 0 0 0 1.5px var(--cue); }
  .strip.selected { background: var(--surface-2); box-shadow: inset 0 0 0 2px var(--accent-text); }
  .strip.selected.cue { box-shadow: inset 0 0 0 2px var(--accent-text), inset 0 0 0 3.5px var(--cue); }
  .num {
    text-align: center;
    font-size: var(--fs-caption2);
    line-height: 13px;
    font-weight: 600;
    color: var(--label-3);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .name {
    height: 28px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    font-weight: 700;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 4px;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.25);
  }
  .name:disabled { cursor: default; }
  .name:not(:disabled):active { filter: brightness(0.9); }
  .buttons { display: flex; flex-direction: column; gap: 6px; }
  .key {
    height: 36px;
    border-radius: 8px;
    font-size: var(--fs-caption);
    font-weight: 700;
    letter-spacing: 0.06em;
    background: var(--surface-2);
    color: var(--label-2);
    transition: background-color 120ms var(--ease), color 120ms, box-shadow 120ms;
  }
  .key:not(:disabled):active { transform: scale(0.96); }
  .key:disabled { opacity: 0.5; }
  .key.on.lit { background: var(--on); color: var(--on-ink); box-shadow: 0 0 12px rgba(48, 209, 88, 0.35); }
  .send .key.on.lit { background: var(--send); color: var(--send-ink); box-shadow: 0 0 12px rgba(255, 159, 10, 0.35); }
  .key.cuebtn { height: 32px; }
  .key.cuebtn.lit { background: var(--cue); color: var(--cue-ink); }
  .value {
    text-align: center;
    font-size: var(--fs-footnote);
    line-height: 24px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: var(--r-xs);
    background: var(--sunken);
  }
  .value.inf { color: var(--label-2); }
  .fader { flex: 1; min-height: 0; }
  .off .fader { opacity: 0.7; }
</style>
