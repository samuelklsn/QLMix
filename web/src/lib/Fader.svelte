<script lang="ts">
  import { FADER_MARKS, levelText, levelToPosition, positionToLevel } from "../../shared/rcp.ts";

  interface Props {
    value: number | undefined;
    accent?: string;
    disabled?: boolean;
    meter?: number | null;
    /** accessible name, e.g. "Kanzel Fader" */
    label?: string;
    onchange: (raw: number) => void;
    ontouch?: (active: boolean) => void;
  }
  let { value, accent = "#30d158", disabled = false, meter = null, label = "Fader", onchange, ontouch }: Props = $props();

  let track: HTMLDivElement;
  let dragging = $state(false);
  let startY = 0;
  let startPos = 0;
  let pointerId: number | null = null;

  const CAP = 44; // cap height in px
  let height = $state(300);
  const travel = $derived(Math.max(1, height - CAP));
  const pos = $derived(levelToPosition(value));

  function down(e: PointerEvent) {
    if (disabled || pointerId !== null) return;
    pointerId = e.pointerId;
    track.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startPos = pos;
    dragging = true;
    ontouch?.(true);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const fine = e.altKey ? 0.25 : 1;
    const p = startPos - ((e.clientY - startY) / travel) * fine;
    const raw = positionToLevel(p);
    if (raw !== value) onchange(raw);
  }

  function up(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    dragging = false;
    ontouch?.(false);
  }

  // Non-passive wheel listener so the page doesn't scroll while adjusting.
  $effect(() => {
    track.addEventListener("wheel", wheel, { passive: false });
    return () => track.removeEventListener("wheel", wheel);
  });

  /** Keyboard: ↑/↓ ±0.5 dB (⇧ ±3 dB), Home = 0 dB, End = −∞ */
  function key(e: KeyboardEvent) {
    if (disabled) return;
    const cur = value === undefined || value <= -13800 ? null : value / 100;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = cur === null ? -60 : cur + (e.shiftKey ? 3 : 0.5);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = cur === null ? null : cur - (e.shiftKey ? 3 : 0.5);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") { e.preventDefault(); onchange(-32768); return; }
    else return;
    e.preventDefault();
    if (next === null) return;
    onchange(next < -100 ? -32768 : Math.round(Math.min(10, next) * 100));
  }

  function wheel(e: WheelEvent) {
    if (disabled) return;
    e.preventDefault();
    const step = (e.altKey ? 0.1 : 0.5) * (e.deltaY < 0 ? 1 : -1);
    const db = value === undefined || value <= -13800 ? -60 : value / 100 + step;
    onchange(Math.round(Math.min(10, db) * 100));
  }
</script>

<div class="fader" class:disabled bind:clientHeight={height}>
  <div class="scale">
    {#each FADER_MARKS as [db, label]}
      <span class:zero={db === 0} style="top: {(1 - (db === null ? 0 : levelToPosition(db * 100))) * travel + CAP / 2}px">{label}</span>
    {/each}
  </div>
  <div
    class="track"
    bind:this={track}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
    role="slider"
    aria-label={label}
    aria-valuemin={-138}
    aria-valuemax={10}
    aria-valuenow={value === undefined || value <= -13800 ? -138 : value / 100}
    aria-valuetext={`${levelText(value)} dB`}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
  >
    <div class="slot" style="top: {CAP / 2}px; bottom: {CAP / 2}px"></div>
    {#if meter !== null}
      <div class="meter" style="top: {CAP / 2}px; bottom: {CAP / 2}px">
        <div class="cover" style="height: {100 - Math.round(meter * 100)}%"></div>
      </div>
    {/if}
    <div class="cap" class:active={dragging} style="transform: translateY({(1 - pos) * travel}px); --accent: {accent}">
      <div class="line"></div>
    </div>
  </div>
</div>

<style>
  .fader {
    position: relative;
    display: flex;
    height: 100%;
    min-height: 160px;
    touch-action: none;
  }
  .disabled { opacity: 0.5; }
  .scale {
    position: relative;
    width: 22px;
    flex: none;
    pointer-events: none;
  }
  .scale span {
    position: absolute;
    right: 3px;
    transform: translateY(-50%);
    font-size: var(--fs-caption2);
    line-height: 1;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .scale span.zero { color: var(--label); font-weight: 700; }
  .track {
    position: relative;
    flex: 1;
    cursor: ns-resize;
    touch-action: none;
    border-radius: var(--r-xs);
  }
  .track:focus-visible { outline-offset: 0; }
  .slot {
    position: absolute;
    left: 50%;
    width: 4px;
    margin-left: -2px;
    border-radius: 2px;
    background: var(--sunken);
    box-shadow: 0 0 0 1px var(--separator);
  }
  .meter {
    position: absolute;
    right: 0;
    width: 4px;
    border-radius: 2px;
    overflow: hidden;
    /* full-height gradient; the cover hides the part above the current level */
    background: linear-gradient(to top, var(--on) 0%, var(--on) 62%, var(--cue) 80%, var(--send) 92%, var(--danger) 100%);
  }
  .meter .cover {
    position: absolute;
    top: 0;
    width: 100%;
    background: var(--sunken);
    transition: height 80ms linear;
  }
  .cap {
    position: absolute;
    top: 0;
    left: 50%;
    width: min(40px, 84%);
    height: 44px;
    translate: -50% 0;
    border-radius: 7px;
    background: linear-gradient(180deg, #e9ebee 0%, #b9bec5 46%, #8e949c 54%, #c4c8ce 100%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.7);
    will-change: transform;
    transition: box-shadow 120ms var(--ease);
  }
  .cap .line {
    position: absolute;
    top: 50%;
    left: 4px;
    right: 4px;
    height: 2px;
    margin-top: -1px;
    border-radius: 1px;
    background: #1b1d22;
  }
  .cap.active { box-shadow: 0 0 0 2px var(--accent), 0 6px 16px rgba(0, 0, 0, 0.6); }
  .cap.active .line { background: var(--accent); }
</style>
