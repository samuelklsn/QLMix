<script lang="ts">
  import { untrack } from "svelte";
  import {
    RACK_BYPASS, RACK_COUNT, RACK_MODULES, RACK_NAME_PARAMS, RACK_PARAMS_PER_SIDE, decodeRackName, rackKey,
    rackMountKey, rackParamIndex,
  } from "../../shared/ql-params.ts";
  import { store } from "./store.svelte.ts";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let selected = $state<number | null>(null);
  let editRaw = $state(false);
  let now = $state(Date.now());
  let flashes = $state<Record<number, number>>({});
  let history = $state<{ index: number; value: number; t: number }[]>([]);
  let prev: Record<number, number | undefined> = {};

  const racks = Array.from({ length: RACK_COUNT }, (_, i) => i);
  const params = Array.from({ length: RACK_PARAMS_PER_SIDE }, (_, i) => i + 1);

  function name(r: number): string {
    const decoded = decodeRackName(RACK_NAME_PARAMS.map((i) => store.num(rackKey(r, i))));
    if (decoded) return decoded;
    const mount = store.num(rackMountKey(r));
    if (mount === undefined) return "–";
    return mount === 0 ? "leer" : `Modul-Typ ${mount}`;
  }
  const bypassed = (r: number, side: "A" | "B") => (store.num(rackKey(r, RACK_BYPASS[side])) ?? 0) !== 0;
  const toggleBypass = (r: number, side: "A" | "B") => store.write([rackKey(r, RACK_BYPASS[side])], bypassed(r, side) ? 0 : 1, true);

  // Tell the server which rack to poll.
  $effect(() => {
    store.watchRack(selected);
    prev = {};
    flashes = {};
    history = [];
    return () => store.watchRack(null);
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(t);
  });

  // Highlight parameters that change (calibration: turn a knob on the console, see which one moves).
  $effect(() => {
    if (selected === null) return;
    const r = selected;
    const indices = [RACK_BYPASS.A, RACK_BYPASS.B, ...params.map((n) => rackParamIndex("A", n)), ...params.map((n) => rackParamIndex("B", n))];
    const values = indices.map((i) => store.num(rackKey(r, i)));
    untrack(() => {
      const t = Date.now();
      const f = { ...flashes };
      const h = [...history];
      let changed = false;
      indices.forEach((i, j) => {
        const v = values[j];
        if (prev[i] !== undefined && v !== undefined && v !== prev[i]) {
          f[i] = t;
          h.unshift({ index: i, value: v, t });
          changed = true;
        }
        prev[i] = v;
      });
      if (changed) { flashes = f; history = h.slice(0, 12); }
    });
  });

  function label(index: number): string {
    if (index === RACK_BYPASS.A) return "Bypass A";
    if (index === RACK_BYPASS.B) return "Bypass B";
    const n = index - 5;
    return n <= RACK_PARAMS_PER_SIDE ? `A·${n}` : `B·${n - RACK_PARAMS_PER_SIDE}`;
  }
  const step = (r: number, i: number, d: number) => store.write([rackKey(r, i), ], (store.num(rackKey(r, i)) ?? 0) + d, true);
</script>

<Sheet title={selected !== null ? `Rack ${selected + 1}` : "Premium Rack"} width={720} {onclose}>
  {#snippet header()}
    {#if selected !== null}
      <div class="rhead">
        <button class="icon-btn" onclick={() => (selected = null)} aria-label="Zurück zur Übersicht"><Icon name="back" /></button>
        <div class="rtitle">
          <span class="t-caption">Rack {selected + 1}</span>
          <h2 class="t-title">{name(selected)}</h2>
        </div>
      </div>
    {:else}
      <h2 class="t-title">Premium Rack</h2>
    {/if}
  {/snippet}

  {#if !store.eqSchema || store.eqSchema.kind !== "ql"}
    <p class="t-footnote">Das Premium Rack ist nur mit einem CL/QL-Pult verfügbar (Editor-Protokoll).</p>
  {:else if selected === null}
    <section>
      <div class="grid">
        {#each racks as r}
          <div class="card">
            <button class="open" onclick={() => (selected = r)} aria-label="Rack {r + 1} öffnen">
              <span class="rnum">Rack {r + 1}</span>
              <b class="rname">{name(r)}</b>
              <span class="chev"><Icon name="forward" size={16} /></span>
            </button>
            <div class="sides">
              {#each ["A", "B"] as const as side}
                <button class="side" class:lit={!bypassed(r, side)} aria-pressed={!bypassed(r, side)} onclick={() => toggleBypass(r, side)}>
                  {side} · {bypassed(r, side) ? "Bypass" : "Aktiv"}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
      <p class="hint t-footnote">Tippe auf ein Rack, um die Parameter zu sehen. Die Bedienoberflächen der einzelnen Module (Portico, Dynamic EQ …) werden nach dem Abgleich am Pult ergänzt.</p>
    </section>
  {:else}
    {@const r = selected}
    {@const moduleControls = RACK_MODULES[name(r)]}
    {#if moduleControls}
      <div class="group">
        {#each moduleControls as c}
          {@const v = store.num(rackKey(r, rackParamIndex("A", c.param)))}
          <div class="ctrl">
            <div class="lbl"><span>{c.label}</span><b class="num">{v === undefined ? "–" : c.text ? c.text(v) : v}</b></div>
            <input type="range" min={c.min} max={c.max} value={v ?? c.min} aria-label={c.label}
              oninput={(e) => store.write([rackKey(r, rackParamIndex("A", c.param))], Number(e.currentTarget.value))} />
          </div>
        {/each}
      </div>
    {/if}

    <section>
      <h3 class="section-title">Kalibrierung – zuletzt geändert</h3>
      <div class="group">
        {#if history.length === 0}
          <p class="t-footnote">Am Pult einen Regler dieses Moduls drehen – hier erscheint, welcher Parameter sich ändert.</p>
        {:else}
          {#each history as h}
            <div class="hist num"><b>{label(h.index)}</b><span>= {h.value}</span><span class="t">vor {Math.round((now - h.t) / 1000)} s</span></div>
          {/each}
        {/if}
      </div>
    </section>

    <section>
      <div class="rawhead">
        <h3 class="section-title">Alle Parameter (Rohwerte)</h3>
        <button class="pill" class:lit={editRaw} aria-pressed={editRaw} onclick={() => (editRaw = !editRaw)}>Bearbeiten</button>
      </div>
      <div class="rawgrid">
        {#each [RACK_BYPASS.A, RACK_BYPASS.B, ...params.map((n) => rackParamIndex("A", n)), ...params.map((n) => rackParamIndex("B", n))] as i}
          {@const v = store.num(rackKey(r, i))}
          <div class="cell" class:flash={now - (flashes[i] ?? 0) < 3000}>
            <span class="k">{label(i)}</span>
            <span class="v num">{v ?? "–"}</span>
            {#if editRaw}
              <span class="btns">
                <button onclick={() => step(r, i, -1)} aria-label="{label(i)} verringern">−</button>
                <button onclick={() => step(r, i, 1)} aria-label="{label(i)} erhöhen">+</button>
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</Sheet>

<style>
  .rhead { display: flex; align-items: center; gap: var(--s3); min-width: 0; }
  .rtitle { display: flex; flex-direction: column; min-width: 0; }
  .rtitle h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { padding: var(--s3) var(--s1) 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(156px, 1fr)); gap: var(--s3); }
  .card { background: var(--surface-1); border-radius: var(--r-md); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s3); }
  .open { position: relative; text-align: left; display: flex; flex-direction: column; gap: 2px; padding-right: 20px; min-height: 44px; }
  .rnum { font-size: var(--fs-caption); font-weight: 600; color: var(--label-2); }
  .rname { font-size: var(--fs-callout); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { position: absolute; right: 0; top: 50%; translate: 0 -50%; color: var(--label-3); display: grid; }
  .sides { display: flex; gap: var(--s2); }
  .side {
    flex: 1; min-height: 32px; border-radius: var(--r-xs);
    font-size: var(--fs-caption); font-weight: 600;
    background: var(--surface-2); color: var(--label-2);
    transition: background-color 120ms var(--ease);
  }
  .side.lit { background: var(--on); color: var(--on-ink); }
  .hist { display: flex; gap: var(--s3); font-size: var(--fs-callout); }
  .hist .t { margin-left: auto; color: var(--label-2); }
  .rawhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s2); }
  .rawhead .section-title { margin: 0; }
  .rawgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: var(--s1); }
  .cell {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--s1);
    background: var(--surface-1); border-radius: var(--r-xs);
    padding: 6px var(--s2); font-size: var(--fs-caption);
    transition: background-color 0.3s;
  }
  .cell.flash { background: rgba(255, 214, 10, 0.22); }
  .cell .k { color: var(--label-2); }
  .btns { display: flex; gap: var(--s1); width: 100%; }
  .btns button { flex: 1; background: var(--surface-3); border-radius: 4px; min-height: 28px; font-size: var(--fs-callout); }
  .ctrl { display: flex; flex-direction: column; gap: var(--s1); }
  .lbl { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .lbl b { color: var(--label); font-weight: 600; }
</style>
