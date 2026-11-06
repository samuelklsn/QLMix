<script lang="ts">
  import { FADER_MARKS, levelToPosition, positionToLevel } from "../../shared/rcp.ts";

  interface Props {
    value: number | undefined;
    accent?: string;
    disabled?: boolean;
    meter?: number | null;
    onchange: (raw: number) => void;
    ontouch?: (active: boolean) => void;
  }
  let { value, accent = "#3fd17a", disabled = false, meter = null, onchange, ontouch }: Props = $props();

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
    role="slider"
    aria-valuenow={value}
    tabindex="-1"
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
    width: 18px;
    flex: none;
    pointer-events: none;
  }
  .scale span {
    position: absolute;
    right: 2px;
    transform: translateY(-50%);
    font-size: 8px;
    color: rgba(255, 255, 255, 0.38);
    font-variant-numeric: tabular-nums;
  }
  .scale span.zero { color: rgba(255, 255, 255, 0.85); font-weight: 700; }
  .track {
    position: relative;
    flex: 1;
    cursor: ns-resize;
    touch-action: none;
  }
  .slot {
    position: absolute;
    left: 50%;
    width: 6px;
    margin-left: -3px;
    border-radius: 3px;
    background: #050607;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }
  .meter {
    position: absolute;
    right: 1px;
    width: 4px;
    border-radius: 2px;
    overflow: hidden;
    /* full-height gradient; the cover hides the part above the current level */
    background: linear-gradient(to top, #34c759 0%, #34c759 62%, #ffd60a 80%, #ff9f0a 92%, #ff453a 100%);
  }
  .meter .cover {
    position: absolute;
    top: 0;
    width: 100%;
    background: #050607;
    transition: height 80ms linear;
  }
  .cap {
    position: absolute;
    top: 0;
    left: 50%;
    width: min(40px, 82%);
    height: 44px;
    transform-origin: center;
    translate: -50% 0;
    border-radius: 6px;
    background: linear-gradient(#cfd3d8, #8d939b 45%, #5d636b 55%, #9aa0a8);
    box-shadow: 0 3px 6px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.5);
    will-change: transform;
  }
  .cap .line {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 3px;
    margin-top: -1.5px;
    background: #111;
  }
  .cap.active { box-shadow: 0 0 0 2px var(--accent), 0 3px 8px rgba(0, 0, 0, 0.7); }
  .cap.active .line { background: var(--accent); }
</style>
