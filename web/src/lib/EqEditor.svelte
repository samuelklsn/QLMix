<script lang="ts">
  import {
    type ChannelId, type EqParam, type EqSettings, EQ_BANDS, EQ_RANGE, bandResponse, bandShape, eqResponse, freqText,
    gainDbText, hasHpf, qText,
  } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";

  let { channel }: { channel: ChannelId } = $props();

  const eq = $derived(store.eq(channel));
  const withHpf = $derived(store.eqSchema ? hasHpf(channel.kind, store.eqSchema) : false);
  $effect(() => { if (!withHpf && selected === "hpf") selected = 1; });
  let selected = $state<number | "hpf">(1);

  const BAND_COLORS = ["#ff5a4e", "#ffc23d", "#4fd66f", "#5aa8ff"];
  const BAND_NAMES = ["LOW", "LO-MID", "HI-MID", "HIGH"];
  const MIN_F = 20, MAX_F = 20000, MAX_DB = 18;

  let canvas: HTMLCanvasElement | undefined = $state();
  let w = $state(320);
  let h = $state(200);

  const x = (f: number) => (Math.log10(f / MIN_F) / Math.log10(MAX_F / MIN_F)) * w;
  const fAt = (px: number) => MIN_F * Math.pow(MAX_F / MIN_F, Math.min(Math.max(px / w, 0), 1));
  const y = (db: number) => ((MAX_DB - db) / (2 * MAX_DB)) * h;
  const dbAt = (py: number) => MAX_DB - (Math.min(Math.max(py, 0), h) / h) * 2 * MAX_DB;
  const hpfY = (e: EqSettings) => Math.min(Math.max(y(e.hpfOn ? eqResponse(e, e.hpfFreq) : -3), 12), h - 12);

  // ------------------------------------------------------------ drawing
  $effect(() => {
    if (!eq || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    g.lineWidth = 1;
    // Grid labels: 11 px, #8a9099 on #07080a ≈ 6:1 (typography.md minimum 11 pt, 4.5:1 contrast).
    g.font = "500 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
    const LABEL = "#8a9099";
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.strokeStyle = f === 100 || f === 1000 || f === 10000 ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.05)";
      g.beginPath(); g.moveTo(x(f) + 0.5, 0); g.lineTo(x(f) + 0.5, h); g.stroke();
      if (f > 20) { g.fillStyle = LABEL; g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x(f) + 4, h - 6); }
    }
    for (let db = -12; db <= 12; db += 6) {
      g.strokeStyle = db === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.05)";
      g.beginPath(); g.moveTo(0, Math.round(y(db)) + 0.5); g.lineTo(w, Math.round(y(db)) + 0.5); g.stroke();
      if (db !== 0) { g.fillStyle = LABEL; g.fillText(`${db > 0 ? "+" : ""}${db}`, 6, y(db) - 4); }
    }

    const curve = (fn: (f: number) => number) => {
      g.beginPath();
      for (let i = 0; i <= 200; i++) {
        const px = (w * i) / 200;
        const py = Math.min(Math.max(y(fn(fAt(px))), -40), h + 40);
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
    };
    if (typeof selected === "number" && eq.on) {
      curve((f) => bandResponse(eq, selected as number, f));
      g.lineTo(w, y(0)); g.lineTo(0, y(0)); g.closePath();
      g.fillStyle = BAND_COLORS[selected] + "38";
      g.fill();
    }
    const color = eq.on ? "#64d2ff" : "#7d838d";
    curve((f) => eqResponse(eq, f));
    g.lineWidth = 2.5;
    g.strokeStyle = color;
    g.stroke();
    g.lineTo(w, y(0)); g.lineTo(0, y(0)); g.closePath();
    g.fillStyle = eq.on ? "rgba(100,210,255,0.09)" : "rgba(125,131,141,0.07)";
    g.fill();

    const node = (px: number, py: number, label: string, fill: string, sel: boolean, dim: boolean) => {
      g.globalAlpha = dim ? 0.45 : 1;
      g.beginPath(); g.arc(px, py, sel ? 13 : 11, 0, Math.PI * 2);
      g.fillStyle = fill; g.fill();
      if (sel) { g.lineWidth = 2.5; g.strokeStyle = "#f2f3f5"; g.stroke(); }
      g.fillStyle = "#111"; g.font = "700 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(label, px, py + 0.5);
      g.textAlign = "start"; g.textBaseline = "alphabetic";
      g.globalAlpha = 1;
    };
    if (withHpf) node(x(eq.hpfFreq), hpfY(eq), "H", "#e6e8eb", selected === "hpf", !eq.hpfOn);
    eq.bands.forEach((b, i) => node(x(b.freq), y(b.gain), String(i + 1), BAND_COLORS[i], selected === i, !eq.on));
  });

  // ------------------------------------------------------------ interaction
  let drag: { target: number | "hpf"; id: number } | null = null;

  function hit(px: number, py: number): number | "hpf" | null {
    if (!eq) return null;
    let best: [number | "hpf", number] | null = null;
    eq.bands.forEach((b, i) => {
      const d = Math.hypot(x(b.freq) - px, y(b.gain) - py);
      if (d < 30 && (!best || d < best[1])) best = [i, d];
    });
    const dh = withHpf ? Math.hypot(x(eq.hpfFreq) - px, hpfY(eq) - py) : Infinity;
    if (dh < 30 && (!best || dh < (best as [number | "hpf", number])[1])) best = ["hpf", dh];
    return best ? (best as [number | "hpf", number])[0] : null;
  }

  const paramsFor = (t: number | "hpf"): EqParam[] =>
    t === "hpf" ? [{ p: "hpfFreq" }] : [{ p: "freq", band: t }, { p: "gain", band: t }];

  function pos(e: PointerEvent) {
    const r = canvas!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function down(e: PointerEvent) {
    const [px, py] = pos(e);
    const t = hit(px, py);
    if (t === null || drag) return;
    selected = t;
    drag = { target: t, id: e.pointerId };
    canvas!.setPointerCapture(e.pointerId);
    store.touch(store.eqKeys(channel, paramsFor(t)), true);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id || !eq) return;
    const [px, py] = pos(e);
    const next = structuredClone($state.snapshot(eq)) as EqSettings;
    if (drag.target === "hpf") {
      next.hpfFreq = clamp(fAt(px), EQ_RANGE.hpf);
    } else {
      next.bands[drag.target].freq = clamp(fAt(px), EQ_RANGE.freq);
      next.bands[drag.target].gain = clamp(Math.round(dbAt(py) * 2) / 2, EQ_RANGE.gain);
    }
    store.writeEq(channel, next, paramsFor(drag.target));
  }

  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    store.touch(store.eqKeys(channel, paramsFor(drag.target)), false);
    drag = null;
  }

  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(Math.max(v, lo), hi);

  function update(params: EqParam[], mutate: (e: EqSettings) => void, immediate = false) {
    if (!eq) return;
    const next = structuredClone($state.snapshot(eq)) as EqSettings;
    mutate(next);
    store.writeEq(channel, next, params, immediate);
  }

  // log slider helpers (0…1000)
  const toLog = (v: number, [lo, hi]: readonly [number, number]) => Math.round((Math.log(v / lo) / Math.log(hi / lo)) * 1000);
  const fromLog = (s: number, [lo, hi]: readonly [number, number]) => lo * Math.pow(hi / lo, s / 1000);
  const touchKeys = (params: EqParam[]) => ({
    onpointerdown: () => store.touch(store.eqKeys(channel, params), true),
    onpointerup: () => store.touch(store.eqKeys(channel, params), false),
  });
</script>

{#if eq}
  <div class="eq">
    <div class="toprow">
      <button class="pill" class:lit={eq.on} aria-pressed={eq.on} onclick={() => update([{ p: "on" }], (e) => (e.on = !e.on), true)}>EQ {eq.on ? "an" : "aus"}</button>
      {#if withHpf}
        <button class="pill" class:lit={eq.hpfOn} aria-pressed={eq.hpfOn} onclick={() => update([{ p: "hpfOn" }], (e) => (e.hpfOn = !e.hpfOn), true)}>HPF {eq.hpfOn ? "an" : "aus"}</button>
      {/if}
      <span class="spacer"></span>
      <button class="pill ghost" aria-label="Alle Bänder auf 0 dB" onclick={() => update(Array.from({ length: EQ_BANDS }, (_, band) => ({ p: "gain", band }) as EqParam), (e) => e.bands.forEach((b) => (b.gain = 0)), true)}>Flat</button>
    </div>

    <div class="graph" bind:clientWidth={w} bind:clientHeight={h}>
      <canvas bind:this={canvas} style="width: {w}px; height: {h}px" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}></canvas>
    </div>

    <div class="segmented tabs" role="tablist" aria-label="Band">
      {#each BAND_NAMES as name, i}
        <button role="tab" aria-selected={selected === i} class:sel={selected === i} style="--c: {BAND_COLORS[i]}" onclick={() => (selected = i)}><i class="swatch"></i>{name}</button>
      {/each}
      {#if withHpf}
        <button role="tab" aria-selected={selected === "hpf"} class:sel={selected === "hpf"} style="--c: #e6e8eb" onclick={() => (selected = "hpf")}><i class="swatch"></i>HPF</button>
      {/if}
    </div>

    {#if selected === "hpf"}
      <div class="ctrl">
        <div class="lbl"><span>Frequenz</span><b>{freqText(eq.hpfFreq)} Hz</b></div>
        <input type="range" min="0" max="1000" value={toLog(eq.hpfFreq, EQ_RANGE.hpf)} {...touchKeys([{ p: "hpfFreq" }])}
          oninput={(ev) => update([{ p: "hpfFreq" }], (e) => (e.hpfFreq = fromLog(+ev.currentTarget.value, EQ_RANGE.hpf)))} />
      </div>
    {:else}
      {@const b = eq.bands[selected]}
      {@const band = selected}
      {#if band === 0 || band === EQ_BANDS - 1}
        <div class="shape">
          <div class="segmented" role="radiogroup" aria-label="Filterform">
          <button role="radio" aria-checked={bandShape(eq, band) === "bell"} class:sel={bandShape(eq, band) === "bell"} onclick={() => update([{ p: band === 0 ? "lowShelf" : "highShelf" }], (e) => (band === 0 ? (e.lowShelf = false) : (e.highShelf = false)), true)}>Bell</button>
          <button role="radio" aria-checked={bandShape(eq, band) !== "bell"} class:sel={bandShape(eq, band) === "lowShelf" || bandShape(eq, band) === "highShelf"} onclick={() => update([{ p: band === 0 ? "lowShelf" : "highShelf" }], (e) => { if (band === 0) e.lowShelf = true; else { e.highShelf = true; e.highLpf = false; } }, true)}>Shelf</button>
          </div>
          {#if band === EQ_BANDS - 1 && eq.highLpf}<span class="tag">LPF</span>{/if}
        </div>
      {/if}
      <div class="ctrl">
        <div class="lbl"><span>Frequenz</span><b>{freqText(b.freq)} Hz</b></div>
        <input type="range" min="0" max="1000" value={toLog(b.freq, EQ_RANGE.freq)} {...touchKeys([{ p: "freq", band }])}
          oninput={(ev) => update([{ p: "freq", band }], (e) => (e.bands[band].freq = fromLog(+ev.currentTarget.value, EQ_RANGE.freq)))} />
      </div>
      <div class="ctrl">
        <div class="lbl"><span>Gain</span><b>{gainDbText(b.gain)} dB</b></div>
        <input type="range" min="-18" max="18" step="0.5" value={b.gain} {...touchKeys([{ p: "gain", band }])}
          oninput={(ev) => update([{ p: "gain", band }], (e) => (e.bands[band].gain = +ev.currentTarget.value))} />
      </div>
      {#if bandShape(eq, band) === "bell"}
        <div class="ctrl">
          <div class="lbl"><span>Q</span><b>{qText(b.q)}</b></div>
          <input type="range" min="0" max="1000" value={1000 - toLog(b.q, EQ_RANGE.q)} {...touchKeys([{ p: "q", band }])}
            oninput={(ev) => update([{ p: "q", band }], (e) => (e.bands[band].q = fromLog(1000 - +ev.currentTarget.value, EQ_RANGE.q)))} />
          <div class="lbl small"><span>Breit</span><span>Schmal</span></div>
        </div>
      {/if}
    {/if}
    <p class="t-footnote">Punkte in der Kurve ziehen: links/rechts = Frequenz, hoch/runter = Gain.</p>
  </div>
{/if}

<style>
  .eq { display: flex; flex-direction: column; gap: var(--s4); }
  .toprow, .shape { display: flex; gap: var(--s2); align-items: center; }
  .shape .segmented { flex: 1; max-width: 240px; }
  .spacer { flex: 1; }
  .graph {
    height: clamp(200px, 34vh, 340px);
    border-radius: var(--r-md);
    background: var(--sunken);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
    touch-action: none;
  }
  canvas { display: block; touch-action: none; }
  .tabs { overflow-x: auto; scrollbar-width: none; }
  .tabs > button { min-width: 64px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: var(--fs-caption); letter-spacing: 0.02em; }
  .swatch { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
  .tag {
    font-size: var(--fs-caption); font-weight: 700; letter-spacing: 0.02em;
    padding: 6px var(--s2); border-radius: var(--r-xs);
    background: var(--surface-2); color: var(--label-2);
  }
  .ctrl { display: flex; flex-direction: column; gap: var(--s1); }
  .ctrl .lbl { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .ctrl b { color: var(--label); font-weight: 600; font-variant-numeric: tabular-nums; }
  .lbl.small { font-size: var(--fs-caption2); margin-top: -6px; }
</style>
