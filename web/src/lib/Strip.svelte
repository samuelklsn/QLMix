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
  }
  let { channel, mix = null, master = false, onopen }: Props = $props();

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

<div class="strip" class:send={sendMode} class:cue class:off={!on} class:master>
  <div class="num">{channelLabel(channel)}</div>
  <button class="name" style="background: {COLOR_HEX[color]}; color: {darkTextColors.includes(color) ? '#111' : '#fff'}" onclick={() => onopen?.(channel)} disabled={!enabled || !onopen}>
    {name}
  </button>
  <div class="buttons">
    <button class="key on" class:lit={on} onclick={toggleOn} disabled={!enabled}>ON</button>
    {#if !sendMode}
      <button class="key cuebtn" class:lit={cue} onclick={toggleCue} disabled={!enabled}>CUE</button>
    {/if}
  </div>
  <div class="value" class:inf={level === undefined || level <= -13800}>{levelText(level)}</div>
  <div class="fader">
    <Fader
      value={level}
      accent={sendMode ? "#ff9f0a" : COLOR_HEX[color]}
      disabled={!enabled}
      {meter}
      onchange={setLevel}
      ontouch={(a) => store.touch(store.levelKeys(channel, mix), a)}
    />
  </div>
</div>

<style>
  .strip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: var(--strip-w, 74px);
    flex: none;
    padding: 6px 5px 8px;
    border-radius: 10px;
    background: var(--strip-bg);
    border: 1px solid rgba(255, 255, 255, 0.05);
    scroll-snap-align: start;
  }
  .strip.send { background: var(--strip-send-bg); }
  .strip.master { background: var(--strip-master-bg); }
  .strip.cue { border-color: rgba(255, 214, 10, 0.75); }
  .num {
    text-align: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .name:disabled { opacity: 1; cursor: default; }
  .name {
    height: 28px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 3px;
  }
  .buttons { display: flex; flex-direction: column; gap: 5px; }
  .key {
    height: 32px;
    border-radius: 7px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    background: #2a2e35;
    color: rgba(255, 255, 255, 0.55);
    transition: background 0.1s;
  }
  .key.on.lit { background: #34c759; color: #06260f; box-shadow: 0 0 10px rgba(52, 199, 89, 0.45); }
  .send .key.on.lit { background: #ff9f0a; color: #2a1700; box-shadow: 0 0 10px rgba(255, 159, 10, 0.45); }
  .key.cuebtn { height: 26px; }
  .key.cuebtn.lit { background: #ffd60a; color: #2a2300; }
  .value {
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 3px 0;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.45);
  }
  .value.inf { color: var(--muted); }
  .fader { flex: 1; min-height: 0; }
  .off .fader { opacity: 0.75; }
</style>
