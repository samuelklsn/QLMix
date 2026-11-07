<script lang="ts">
  import { untrack } from "svelte";
  import {
    RACK_BYPASS, RACK_COUNT, RACK_MODULES, RACK_NAME_PARAMS, RACK_PARAMS_PER_SIDE, decodeRackName, rackKey,
    rackMountKey, rackParamIndex,
  } from "../../shared/ql-params.ts";
  import { store } from "./store.svelte.ts";

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

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-label="Premium Rack">
  <header>
    {#if selected !== null}
      <button class="icon" onclick={() => (selected = null)} aria-label="Zurück">‹</button>
      <h2>Rack {selected + 1} · {name(selected)}</h2>
    {:else}
      <h2>Premium Rack</h2>
    {/if}
    <span class="spacer"></span>
    <button class="icon" onclick={onclose} aria-label="Schließen">✕</button>
  </header>

  <div class="body">
    {#if !store.eqSchema || store.eqSchema.kind !== "ql"}
      <p class="note">Das Premium Rack ist nur mit einem CL/QL-Pult verfügbar (Editor-Protokoll).</p>
    {:else if selected === null}
      <div class="grid">
        {#each racks as r}
          <div class="card">
            <button class="open" onclick={() => (selected = r)}>
              <span class="num">Rack {r + 1}</span>
              <b>{name(r)}</b>
            </button>
            <div class="sides">
              {#each ["A", "B"] as const as side}
                <button class="pill small" class:lit={!bypassed(r, side)} onclick={() => toggleBypass(r, side)}>
                  {side} {bypassed(r, side) ? "Bypass" : "aktiv"}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
      <p class="note">Tippe auf ein Rack, um die Parameter zu sehen. Die Bedienoberflächen der einzelnen Module (Portico, Dynamic EQ …) werden nach dem Abgleich am Pult ergänzt.</p>
    {:else}
      {@const r = selected}
      {@const moduleControls = RACK_MODULES[name(r)]}
      {#if moduleControls}
        <section>
          {#each moduleControls as c}
            {@const v = store.num(rackKey(r, rackParamIndex("A", c.param)))}
            <div class="ctrl">
              <div class="lbl"><span>{c.label}</span><b>{v === undefined ? "–" : c.text ? c.text(v) : v}</b></div>
              <input type="range" min={c.min} max={c.max} value={v ?? c.min}
                oninput={(e) => store.write([rackKey(r, rackParamIndex("A", c.param))], Number(e.currentTarget.value))} />
            </div>
          {/each}
        </section>
      {/if}

      <section class="calib">
        <h3>Kalibrierung – zuletzt geändert</h3>
        {#if history.length === 0}
          <p class="note">Am Pult einen Regler dieses Moduls drehen – hier erscheint, welcher Parameter sich ändert.</p>
        {:else}
          {#each history as h}
            <div class="hist"><b>{label(h.index)}</b><span>= {h.value}</span><span class="t">{Math.round((now - h.t) / 1000)} s</span></div>
          {/each}
        {/if}
      </section>

      <section>
        <div class="rawhead">
          <h3>Alle Parameter (Rohwerte)</h3>
          <label class="edit"><input type="checkbox" bind:checked={editRaw} /> bearbeiten</label>
        </div>
        <div class="rawgrid">
          {#each [RACK_BYPASS.A, RACK_BYPASS.B, ...params.map((n) => rackParamIndex("A", n)), ...params.map((n) => rackParamIndex("B", n))] as i}
            {@const v = store.num(rackKey(r, i))}
            <div class="cell" class:flash={now - (flashes[i] ?? 0) < 3000}>
              <span class="k">{label(i)}</span>
              <span class="v">{v ?? "–"}</span>
              {#if editRaw}
                <span class="btns"><button onclick={() => step(r, i, -1)}>−</button><button onclick={() => step(r, i, 1)}>+</button></span>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 20; }
  .sheet {
    position: fixed; z-index: 21; left: 50%; bottom: 0; translate: -50% 0;
    width: min(720px, 100%); max-height: 94dvh; display: flex; flex-direction: column;
    background: #15181d; border-radius: 18px 18px 0 0; border: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: env(safe-area-inset-bottom);
  }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 6px; }
  h2 { margin: 0; font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
  .spacer { flex: 1; }
  .icon { width: 36px; height: 36px; border-radius: 10px; background: #23272e; font-size: 18px; flex: none; }
  .body { overflow-y: auto; padding: 8px 14px 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .card { background: #1d2127; border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .open { text-align: left; display: flex; flex-direction: column; gap: 2px; }
  .num { font-size: 11px; color: var(--muted); }
  .sides { display: flex; gap: 6px; }
  .pill.small { height: 30px; padding: 0 8px; font-size: 11px; flex: 1; }
  .note { color: var(--muted); font-size: 12px; line-height: 1.45; }
  section { margin: 10px 0 16px; }
  .calib { background: #1b1f25; border-radius: 12px; padding: 10px 12px; }
  .hist { display: flex; gap: 10px; font-size: 13px; font-variant-numeric: tabular-nums; padding: 2px 0; }
  .hist .t { margin-left: auto; color: var(--muted); }
  .rawhead { display: flex; align-items: center; justify-content: space-between; }
  .edit { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
  .rawgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 4px; }
  .cell { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px; background: #1b1f25; border-radius: 6px; padding: 4px 6px; font-size: 11px; transition: background 0.3s; }
  .cell.flash { background: #4a3a10; }
  .cell .k { color: var(--muted); }
  .cell .v { font-variant-numeric: tabular-nums; }
  .btns { display: flex; gap: 4px; width: 100%; }
  .btns button { flex: 1; background: #2a2f37; border-radius: 4px; height: 22px; }
  .ctrl { display: flex; flex-direction: column; }
  .lbl { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
  .lbl b { color: var(--text); }
</style>
