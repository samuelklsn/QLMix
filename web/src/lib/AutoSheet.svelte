<script lang="ts">
  import { onDestroy } from "svelte";
  import { type ChannelId, channelLabel, channelParamKey, channelsOf } from "../../shared/rcp.ts";
  import { RoomMeter } from "./room-meter.ts";
  import { store } from "./store.svelte.ts";

  let { onclose }: { onclose: () => void } = $props();

  const auto = $derived(store.auto);
  const st = $derived(auto?.status);
  const cfg = $derived(auto?.config);
  const model = $derived(store.model);
  const inputs = $derived(model ? [...channelsOf(model, "input"), ...channelsOf(model, "stereoInput")] : []);

  // ------------------------------------------------------------ measuring on this device
  let meter: RoomMeter | null = null;
  let measuringHere = $state(false);
  let measureError = $state<string | null>(null);
  let localLevel = $state<number | null>(null);
  let ports = $state({ httpPort: Number(location.port || 80), httpsPort: 8443 as number | null });

  fetch("/api/endpoints").then((r) => r.json()).then((p) => (ports = p)).catch(() => {});

  async function toggleMeasure() {
    measureError = null;
    if (measuringHere) {
      meter?.stop();
      meter = null;
      measuringHere = false;
      return;
    }
    try {
      meter = new RoomMeter();
      await meter.start((s) => {
        localLevel = s.level;
        store.sendRoom(s.level, s.feedback);
      });
      measuringHere = true;
    } catch (e) {
      meter = null;
      measureError = e instanceof Error && e.name === "NotAllowedError"
        ? "Mikrofon-Zugriff wurde nicht erlaubt (Einstellungen → Safari → Mikrofon)."
        : `Mikrofon konnte nicht gestartet werden: ${e instanceof Error ? e.message : e}`;
    }
  }
  onDestroy(() => meter?.stop());

  const host = location.hostname;
  const httpsUrl = $derived(ports.httpsPort ? `https://${host}:${ports.httpsPort}${location.pathname}` : null);
  const certUrl = $derived(`http://${host}:${ports.httpPort}/qlmix-ca.crt`);

  // ------------------------------------------------------------ helpers
  const selected = (c: ChannelId) => !!cfg?.channels.some((x) => x.kind === c.kind && x.index === c.index);
  function toggleChannel(c: ChannelId) {
    if (!cfg) return;
    const channels = selected(c) ? cfg.channels.filter((x) => !(x.kind === c.kind && x.index === c.index)) : [...cfg.channels, c];
    store.autoAction("config", { channels });
  }
  const name = (c: ChannelId) => {
    const v = store.get(channelParamKey(c, "name"));
    return typeof v === "string" && v ? v : channelLabel(c);
  };
  const pct = (db: number | null | undefined) => (db === null || db === undefined ? 0 : Math.max(0, Math.min(100, ((db + 80) / 80) * 100)));
  const fmt = (db: number | null | undefined) => (db === null || db === undefined ? "–" : `${db.toFixed(1)} dB`);
  const speeds = [{ v: 0.5, l: "langsam" }, { v: 1, l: "normal" }, { v: 2, l: "schnell" }];
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-label="Raum-Automatik">
  <header>
    <h2>Raum-Automatik <span class="badge">Test</span></h2>
    <button class="icon" onclick={onclose} aria-label="Schließen">✕</button>
  </header>

  <div class="body">
    {#if !auto || !cfg || !st}
      <p class="note">Verbinde …</p>
    {:else}
      <!-- Status + start/stop -->
      <div class="status {st.level}">
        <span class="dot"></span>
        <div>
          <b>{st.message}</b>
          <small>
            {st.active ? `Aktives Mikro: ${st.active}` : "Kein aktives Mikro"} ·
            {st.metersAvailable ? "erkannt über Pult-Pegel" : "Erkennung: einziges offenes Mikro"}
          </small>
        </div>
      </div>
      {#if st.enabled}
        <button class="big stop" onclick={() => store.autoAction("stop")}>■ Automatik stoppen</button>
      {:else}
        <button class="big start" onclick={() => store.autoAction("start")} disabled={!cfg.channels.length || cfg.reference === null}>▶ Automatik starten</button>
      {/if}
      {#if store.autoError}<p class="err">{store.autoError}</p>{/if}

      <!-- 1 Measurement -->
      <section>
        <h3>1 · Messung in der Raummitte</h3>
        {#if !RoomMeter.supported}
          <div class="box">
            <p><b>Für das Mikrofon braucht dieses Gerät die sichere Verbindung.</b> Einmalig einrichten:</p>
            <ol>
              <li><a href={certUrl}>QLMix-Zertifikat laden</a> → „Erlauben“.</li>
              <li>Einstellungen → Allgemein → <i>VPN und Geräteverwaltung</i> → „QLMix Local CA“ → Installieren.</li>
              <li>Einstellungen → Allgemein → Info → <i>Zertifikatsvertrauenseinstellungen</i> → „QLMix Local CA“ einschalten.</li>
              <li>Dann diese Seite sicher öffnen:</li>
            </ol>
            {#if httpsUrl}<a class="pill lit link" href={httpsUrl}>Sicher öffnen (HTTPS)</a>{/if}
          </div>
        {:else}
          <button class="pill wide" class:lit={measuringHere} onclick={toggleMeasure}>
            {measuringHere ? "● Dieses Handy misst – tippen zum Beenden" : "Dieses Handy misst den Raum"}
          </button>
          {#if measureError}<p class="err">{measureError}</p>{/if}
          <p class="small">Handy in die Mitte des Raums legen, Bildschirm an und QLMix im Vordergrund lassen.</p>
        {/if}
        {#if auto.measuring && !measuringHere}<p class="small">Ein anderes Gerät misst gerade.</p>{/if}

        <div class="meter">
          <div class="bar" style="width: {pct(st.room.level ?? localLevel)}%"></div>
          {#if st.room.floor !== null}<div class="mark floor" style="left: {pct(st.room.floor)}%" title="Grundrauschen"></div>{/if}
          {#if st.room.speech !== null}<div class="mark speech" style="left: {pct(st.room.speech)}%" title="Sprache"></div>{/if}
          {#if st.room.target !== null}<div class="mark target" style="left: {pct(st.room.target)}%" title="Ziel"></div>{/if}
        </div>
        <div class="legend">
          <span>Jetzt {fmt(st.room.level ?? localLevel)}</span>
          <span class="s">Sprache {fmt(st.room.speech)}</span>
          <span class="t">Ziel {fmt(st.room.target)}</span>
          <span class="f">Ruhe {fmt(st.room.floor)}</span>
        </div>
        {#if st.feedback}<p class="err">Rückkopplung erkannt!</p>{/if}
      </section>

      <!-- 2 Target -->
      <section>
        <h3>2 · Ziel-Lautstärke</h3>
        <button class="pill wide" onclick={() => store.autoAction("reference")}>So soll es klingen</button>
        <p class="small">Während eine Person in normaler Lautstärke spricht und es im Raum gut klingt, drücken – das wird das Ziel.
          {#if cfg.reference !== null}Aktuell: {cfg.reference.toFixed(1)} dB.{/if}</p>
        <div class="ctrl">
          <div class="lbl"><span>leiser</span><b>{cfg.offset > 0 ? "+" : ""}{cfg.offset.toFixed(1)} dB</b><span>lauter</span></div>
          <input type="range" min="-10" max="10" step="0.5" value={cfg.offset}
            onchange={(e) => store.autoAction("config", { offset: Number(e.currentTarget.value) })} />
        </div>
      </section>

      <!-- 3 Channels -->
      <section>
        <h3>3 · Sprecher-Mikrofone</h3>
        <p class="small">Nur diese Kanäle darf die Automatik bewegen (z. B. Kanzel, Rednerpult, Funkmikros) – keine Instrumente oder Gesang.</p>
        <div class="chgrid">
          {#each inputs as c}
            {@const sel = selected(c)}
            {@const corr = st.corrections[`${c.kind}:${c.index}`]}
            <button class="ch" class:sel class:active={st.activeKey === `${c.kind}:${c.index}`} onclick={() => toggleChannel(c)}>
              <span class="n">{channelLabel(c)}</span>
              <b>{name(c)}</b>
              {#if sel && corr !== undefined}<span class="corr">{corr > 0 ? "+" : ""}{corr.toFixed(1)} dB</span>{/if}
            </button>
          {/each}
        </div>
      </section>

      <!-- 4 Limits -->
      <section>
        <h3>4 · Grenzen</h3>
        <div class="ctrl">
          <div class="lbl"><span>Max. anheben</span><b>+{cfg.maxBoost} dB</b></div>
          <input type="range" min="0" max="12" step="1" value={cfg.maxBoost} onchange={(e) => store.autoAction("config", { maxBoost: Number(e.currentTarget.value) })} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Max. absenken</span><b>−{cfg.maxCut} dB</b></div>
          <input type="range" min="0" max="20" step="1" value={cfg.maxCut} onchange={(e) => store.autoAction("config", { maxCut: Number(e.currentTarget.value) })} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Fader nie über</span><b>{cfg.ceiling > 0 ? "+" : ""}{cfg.ceiling} dB</b></div>
          <input type="range" min="-10" max="10" step="1" value={cfg.ceiling} onchange={(e) => store.autoAction("config", { ceiling: Number(e.currentTarget.value) })} />
        </div>
        <div class="speeds">
          {#each speeds as s}
            <button class="pill" class:lit={cfg.speed === s.v} onclick={() => store.autoAction("config", { speed: s.v })}>{s.l}</button>
          {/each}
        </div>
      </section>

      <p class="small">Die Automatik regelt nur, wenn ein ausgewähltes Mikro aktiv ist und gesprochen wird. Bei Musik bitte ausschalten.
        Fader, die du selbst bewegst, lässt sie 20 Sekunden in Ruhe. Bei Rückkopplung wird sofort um 3 dB abgesenkt.</p>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 20; }
  .sheet {
    position: fixed; z-index: 21; left: 50%; bottom: 0; translate: -50% 0;
    width: min(640px, 100%); max-height: 94dvh; display: flex; flex-direction: column;
    background: #15181d; border-radius: 18px 18px 0 0; border: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: env(safe-area-inset-bottom);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 6px; }
  h2 { margin: 0; font-size: 18px; display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 11px; background: #ff9f0a; color: #241400; border-radius: 6px; padding: 2px 6px; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  .icon { width: 36px; height: 36px; border-radius: 10px; background: #23272e; }
  .body { overflow-y: auto; padding: 6px 14px 22px; }
  section { margin: 18px 0; display: flex; flex-direction: column; gap: 8px; }
  .status { display: flex; gap: 10px; align-items: flex-start; background: #1d2127; border-radius: 12px; padding: 10px 12px; }
  .status div { display: flex; flex-direction: column; gap: 2px; }
  .status small { color: var(--muted); }
  .status .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex: none; background: #8b929c; }
  .status.ok .dot { background: #34c759; }
  .status.warn .dot { background: #ff9f0a; }
  .big { width: 100%; height: 54px; border-radius: 14px; font-size: 17px; font-weight: 800; margin-top: 10px; }
  .big.start { background: #34c759; color: #06260f; }
  .big.stop { background: #ff453a; color: #fff; }
  .pill.wide { width: 100%; height: 44px; }
  .link { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
  .box { background: #1d2127; border-radius: 12px; padding: 10px 12px; font-size: 13px; line-height: 1.45; }
  .box ol { margin: 6px 0 10px; padding-left: 20px; }
  .box a { color: #6fd8ff; }
  .box a.link { color: #06260f; margin-top: 4px; }
  .err { color: #ff6b5e; font-size: 13px; margin: 6px 0 0; }
  .small, .note { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 0; }
  .meter { position: relative; height: 16px; border-radius: 8px; background: #0b0d10; overflow: hidden; }
  .bar { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #2f7d4a, #34c759); transition: width 0.15s linear; }
  .mark { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1px; }
  .mark.floor { background: #8b929c; }
  .mark.speech { background: #6fd8ff; }
  .mark.target { background: #ffd60a; width: 4px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
  .legend .s { color: #6fd8ff; } .legend .t { color: #ffd60a; } .legend .f { color: var(--muted); }
  .ctrl { display: flex; flex-direction: column; }
  .lbl { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
  .lbl b { color: var(--text); font-variant-numeric: tabular-nums; }
  .chgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
  .ch { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 8px; border-radius: 9px; background: #1d2127; border: 1px solid transparent; text-align: left; }
  .ch .n { font-size: 10px; color: var(--muted); }
  .ch b { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .ch.sel { border-color: #34c759; background: #18291d; }
  .ch.active { box-shadow: 0 0 0 2px #ffd60a; }
  .ch .corr { font-size: 11px; color: #ffd60a; font-variant-numeric: tabular-nums; }
  .speeds { display: flex; gap: 8px; }
  .speeds .pill { flex: 1; }
</style>
