<script lang="ts">
  import type { ChannelId } from "../../shared/rcp.ts";
  import {
    DYNA_CONTROLS, DYNA_LAYOUT, type DynaParam, dynaFamily, dynaKey, dynaSlots, dynaTypeNames, dynaWriteKeys,
    releaseLabel,
  } from "../../shared/ql-params.ts";
  import { store } from "./store.svelte.ts";

  let { channel }: { channel: ChannelId } = $props();

  const schema = $derived(store.eqSchema);
  const slots = $derived(Array.from({ length: dynaSlots(channel.kind) }, (_, i) => i));

  function raw(slot: number, p: DynaParam): number | undefined {
    if (!schema) return undefined;
    const k = dynaKey(channel, slot, p, schema);
    return k ? store.num(k) : undefined;
  }
  function write(slot: number, p: DynaParam, v: number, immediate = false) {
    if (schema) store.write(dynaWriteKeys(channel, slot, p, schema), v, immediate);
  }
  function touch(slot: number, p: DynaParam, active: boolean) {
    if (schema) store.touch(dynaWriteKeys(channel, slot, p, schema), active);
  }
</script>

{#if !schema || schema.kind !== "ql"}
  <p class="note">Dynamics sind nur mit einem CL/QL-Pult verfügbar (Editor-Protokoll).</p>
{:else}
  {#each slots as slot}
    {@const typeRaw = raw(slot, "type")}
    {@const names = dynaTypeNames(channel.kind, slot)}
    {@const typeName = typeRaw !== undefined ? names[typeRaw] : undefined}
    {@const family = dynaFamily(typeName)}
    {@const on = (raw(slot, "on") ?? 0) !== 0}
    <section class="dyna" class:off={!on}>
      <header>
        <h3>Dynamics {slot + 1}</h3>
        <select value={typeRaw ?? ""} onchange={(e) => write(slot, "type", Number(e.currentTarget.value), true)}>
          {#each names as n, i}<option value={i}>{n}</option>{/each}
          {#if typeRaw !== undefined && typeRaw >= names.length}<option value={typeRaw}>Typ {typeRaw}</option>{/if}
        </select>
        <button class="pill" class:lit={on} onclick={() => write(slot, "on", on ? 0 : 1, true)}>{on ? "ON" : "OFF"}</button>
      </header>

      {#each DYNA_LAYOUT[family] as p}
        {@const c = DYNA_CONTROLS[p]}
        {@const v = raw(slot, p)}
        {#if c}
          <div class="ctrl">
            <div class="lbl">
              <span>{p === "release" ? releaseLabel(family) : c.label}</span>
              <b>
                {#if !c.calibrated}<span class="approx" title="Anzeige noch nicht mit dem Pult abgeglichen">≈</span>{/if}
                {v === undefined ? "–" : c.text(v)}
                {#if store.rawMode}<span class="raw">[{v ?? "–"}]</span>{/if}
              </b>
            </div>
            <input type="range" min={c.min} max={c.max} step="1" value={v ?? c.min} disabled={v === undefined}
              onpointerdown={() => touch(slot, p, true)} onpointerup={() => touch(slot, p, false)}
              oninput={(e) => write(slot, p, Number(e.currentTarget.value))} />
          </div>
        {/if}
      {/each}
    </section>
  {/each}
  <p class="hint"><span class="approx">≈</span> = Anzeige noch nicht mit dem Pult abgeglichen (Regler funktionieren, die angezeigten Einheiten können abweichen).</p>
{/if}

<style>
  .dyna { background: #1b1f25; border-radius: 12px; padding: 10px 12px 4px; margin-bottom: 12px; }
  .dyna.off { opacity: 0.7; }
  header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  h3 { margin: 0; font-size: 14px; flex: 1; }
  select {
    font: inherit; font-size: 14px; color: var(--text); background: #0b0d10;
    border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; padding: 6px 8px;
  }
  .ctrl { display: flex; flex-direction: column; margin-bottom: 4px; }
  .lbl { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
  .lbl b { color: var(--text); font-variant-numeric: tabular-nums; }
  .approx { color: #ffb340; margin-right: 3px; }
  .raw { color: var(--muted); font-weight: 400; margin-left: 4px; font-size: 11px; }
  .note, .hint { color: var(--muted); font-size: 12px; }
</style>
