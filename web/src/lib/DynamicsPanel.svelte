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
  <p class="t-footnote">Dynamics sind nur mit einem CL/QL-Pult verfügbar (Editor-Protokoll).</p>
{:else}
  {#each slots as slot}
    {@const typeRaw = raw(slot, "type")}
    {@const names = dynaTypeNames(channel.kind, slot)}
    {@const typeName = typeRaw !== undefined ? names[typeRaw] : undefined}
    {@const family = dynaFamily(typeName)}
    {@const on = (raw(slot, "on") ?? 0) !== 0}
    <section class="group dyna">
      <header>
        <h3 class="t-headline">Dynamics {slot + 1}</h3>
        <select aria-label="Typ Dynamics {slot + 1}" value={typeRaw ?? ""} onchange={(e) => write(slot, "type", Number(e.currentTarget.value), true)}>
          {#each names as n, i}<option value={i}>{n}</option>{/each}
          {#if typeRaw !== undefined && typeRaw >= names.length}<option value={typeRaw}>Typ {typeRaw}</option>{/if}
        </select>
        <button class="pill" class:lit={on} aria-pressed={on} onclick={() => write(slot, "on", on ? 0 : 1, true)}>{on ? "An" : "Aus"}</button>
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
            <input type="range" min={c.min} max={c.max} step="1" value={v ?? c.min} disabled={v === undefined} aria-label={p === "release" ? releaseLabel(family) : c.label}
              onpointerdown={() => touch(slot, p, true)} onpointerup={() => touch(slot, p, false)}
              oninput={(e) => write(slot, p, Number(e.currentTarget.value))} />
          </div>
        {/if}
      {/each}
    </section>
  {/each}
  <p class="t-footnote"><span class="approx">≈</span> = Anzeige noch nicht mit dem Pult abgeglichen (Regler funktionieren, die angezeigten Einheiten können abweichen).</p>
{/if}

<style>
  .dyna { gap: var(--s3); }
  header { display: flex; align-items: center; gap: var(--s2); }
  h3 { flex: 1; }
  select { min-height: var(--h-compact); font-size: var(--fs-callout); padding: 0 var(--s2); }
  .ctrl { display: flex; flex-direction: column; gap: 2px; }
  .lbl { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .lbl b { color: var(--label); font-weight: 600; font-variant-numeric: tabular-nums; }
  .approx { color: var(--warn); margin-right: 3px; }
  .raw { color: var(--label-2); font-weight: 400; margin-left: 4px; font-size: var(--fs-caption2); }
</style>
