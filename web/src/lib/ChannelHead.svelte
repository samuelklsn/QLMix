<script lang="ts">
  // Top of the channel panel: live level, fader, ON/CUE and gain – so EQ work never needs the mixer view.
  import {
    type ChannelId, GAIN_MAX, GAIN_MIN, channelParamKey, channelWriteKeys, gainText, hasGain, levelText, levelToPosition,
    meterNorm, positionToLevel,
  } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";

  let { channel }: { channel: ChannelId } = $props();

  const level = $derived(store.level(channel, null));
  const on = $derived(store.isOn(channel, null));
  const cue = $derived((store.num(channelParamKey(channel, "cue")) ?? 0) !== 0);
  const gain = $derived(store.num(channelParamKey(channel, "gain")));
  const withGain = $derived(hasGain(channel.kind));
  const raw = $derived(store.meters[channel.kind]?.[channel.index]);
  const meter = $derived(raw === undefined ? null : meterNorm(raw));
  const meterLabel = $derived(channel.kind === "input" || channel.kind === "stereoInput" ? "Eingang (vor EQ)" : "Ausgang");

  // Peak hold (1.5 s)
  let peak = $state(0);
  let peakAt = 0;
  $effect(() => {
    const m = meter ?? 0;
    const now = performance.now();
    if (m >= peak || now - peakAt > 1500) { peak = m; peakAt = now; }
  });
  // The number shows the held peak – a raw meter value changes too fast to read.
  const db = $derived(meter === null ? null : Math.round(peak * 60 - 60));

  const TICKS = [-60, -48, -36, -24, -18, -12, -6, 0];
  const tickPos = (d: number) => ((d + 60) / 60) * 100;

  function setLevel(pos: number) {
    store.write(store.levelKeys(channel, null), positionToLevel(pos / 1000));
  }
  function setGain(v: number) {
    store.write(channelWriteKeys(channel, "gain"), Math.round(Math.min(GAIN_MAX, Math.max(GAIN_MIN, v)) / 100) * 100);
  }
  const touch = (a: boolean) => store.touch(store.levelKeys(channel, null), a);
</script>

<div class="head">
  {#if meter !== null}
    <div class="meterblock">
      <div class="mlabel">
        <span>{meterLabel}</span>
        <b class="num" class:hot={peak >= 0.97}>{db === null || db <= -60 ? "–" : `${db > 0 ? "+" : ""}${db} dB`}</b>
      </div>
      <div class="hmeter" aria-hidden="true">
        <div class="hcover" style="width: {100 - meter * 100}%"></div>
        {#if peak > 0.02}<div class="hpeak" class:hot={peak >= 0.97} style="left: {peak * 100}%"></div>{/if}
      </div>
      <div class="ticks" aria-hidden="true">
        {#each TICKS as t}<span style="left: {tickPos(t)}%">{t}</span>{/each}
      </div>
    </div>
  {/if}

  <div class="faderrow">
    <button class="key" class:on-lit={on} aria-pressed={on} onclick={() => store.write(store.onKeys(channel, null), on ? 0 : 1, true)}>ON</button>
    {#if channel.kind !== "dca"}
      <button class="key" class:cue-lit={cue} aria-pressed={cue} onclick={() => store.write(channelWriteKeys(channel, "cue"), cue ? 0 : 1, true)}>CUE</button>
    {/if}
    <div class="hfader">
      <input type="range" min="0" max="1000" step="1" value={Math.round(levelToPosition(level) * 1000)} aria-label="Fader" aria-valuetext="{levelText(level)} dB"
        onpointerdown={() => touch(true)} onpointerup={() => touch(false)} onpointercancel={() => touch(false)}
        oninput={(e) => setLevel(+e.currentTarget.value)} ondblclick={() => store.write(store.levelKeys(channel, null), 0, true)} />
    </div>
    <span class="lvl num" class:inf={level === undefined || level <= -13800}>{levelText(level)}</span>
  </div>

  {#if withGain}
    <div class="gainrow">
      <span class="glabel">Gain</span>
      <span class="gval num">{gainText(gain)}</span>
      <button class="step" onclick={() => setGain((gain ?? 0) - 100)} aria-label="Gain −1 dB">−</button>
      <button class="step" onclick={() => setGain((gain ?? 0) + 100)} aria-label="Gain +1 dB">+</button>
    </div>
  {/if}
</div>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-radius: var(--r-md);
    background: var(--surface-1);
  }
  .meterblock { display: flex; flex-direction: column; gap: 6px; }
  .mlabel { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .mlabel b { color: var(--label); font-weight: 600; }
  .mlabel b.hot { color: var(--danger-text); }
  .hmeter {
    position: relative;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: linear-gradient(90deg, var(--on) 0%, var(--on) 70%, var(--cue) 85%, var(--send) 93%, var(--danger) 100%);
  }
  .hcover { position: absolute; top: 0; bottom: 0; right: 0; background: var(--sunken); transition: width 60ms linear; }
  .hpeak { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--label); }
  .hpeak.hot { background: var(--danger); }
  .ticks { position: relative; height: 13px; }
  .ticks span {
    position: absolute;
    translate: -50% 0;
    font-size: var(--fs-caption2);
    line-height: 13px;
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .ticks span:first-child { translate: 0 0; }
  .ticks span:last-child { translate: -100% 0; }

  .faderrow { display: flex; align-items: center; gap: var(--s2); }
  .key {
    flex: none;
    min-width: 52px;
    height: var(--h-compact);
    border-radius: 8px;
    font-size: var(--fs-caption);
    font-weight: 700;
    letter-spacing: 0.06em;
    background: var(--surface-2);
    color: var(--label-2);
    transition: background-color 120ms var(--ease), color 120ms;
  }
  .key.on-lit { background: var(--on); color: var(--on-ink); }
  .key.cue-lit { background: var(--cue); color: var(--cue-ink); }
  .hfader { flex: 1; min-width: 0; padding: 0 var(--s1); }
  .lvl {
    flex: none;
    min-width: 58px;
    text-align: right;
    font: 600 var(--fs-headline) / 22px var(--font);
  }
  .lvl.inf { color: var(--label-2); }

  .gainrow { display: flex; align-items: center; gap: var(--s2); }
  .glabel { font-size: var(--fs-footnote); color: var(--label-2); }
  .gval { flex: 1; font-size: var(--fs-callout); font-weight: 600; }
  .step {
    width: 44px;
    height: var(--h-compact);
    border-radius: 8px;
    background: var(--surface-2);
    font-size: var(--fs-headline);
    font-weight: 600;
  }
  .step:hover, .key:hover { background-color: var(--surface-3); }
  .key.on-lit:hover { background: var(--on); }
  .key.cue-lit:hover { background: var(--cue); }
</style>
