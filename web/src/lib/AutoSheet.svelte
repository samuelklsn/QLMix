<script lang="ts">
  import { onDestroy } from "svelte";
  import { type ChannelId, channelLabel, channelParamKey, channelsOf } from "../../shared/rcp.ts";
  import { RoomMeter } from "./room-meter.ts";
  import { store } from "./store.svelte.ts";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";

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
  const speeds = [{ v: 0.5, l: "Langsam" }, { v: 1, l: "Normal" }, { v: 2, l: "Schnell" }];

  /** What is still missing before the automatic can start – shown as a checklist. */
  const missing = $derived.by(() => {
    const out: string[] = [];
    if (!cfg) return out;
    if (!cfg.channels.length) out.push("Unter 3 die Sprecher-Mikrofone antippen.");
    if (!st?.room.fresh) out.push("Unter 1 die Messung starten (Handy in der Raummitte).");
    if (cfg.reference === null) out.push("Unter 2 „So soll es klingen“ drücken, während jemand normal spricht.");
    return out;
  });
</script>

<Sheet title="Raum-Automatik" badge="Test" {onclose}>
  {#if !auto || !cfg || !st}
    <p class="t-footnote">Verbinde …</p>
  {:else}
    <!-- Status + start/stop -->
    <div class="hero">
      <div class="status {st.level}">
        <span class="sdot"></span>
        <div class="stext">
          <b class="t-headline">{st.message}</b>
          <span class="t-footnote">
            {st.active ? `Aktives Mikro: ${st.active}` : "Kein aktives Mikro"} ·
            {st.metersAvailable ? "erkannt über Pult-Pegel" : "Erkennung: einziges offenes Mikro"}
          </span>
        </div>
      </div>
      {#if st.enabled}
        <button class="pill danger wide cta" onclick={() => store.autoAction("stop")}><Icon name="stop" size={16} /> Automatik stoppen</button>
      {:else}
        <button class="pill wide cta" class:primary={missing.length === 0} onclick={() => store.autoAction("start")}><Icon name="play" size={16} /> Automatik starten</button>
        {#if missing.length > 0}
          <div class="todo">
            <span class="todo-title"><Icon name="warning" size={15} /> Noch zu tun</span>
            <ul>{#each missing as m}<li>{m}</li>{/each}</ul>
          </div>
        {/if}
      {/if}
      {#if store.autoError && store.autoErrorAction !== "reference"}<p class="err" role="alert">{store.autoError}</p>{/if}
    </div>

    <!-- Live detection per selected mic -->
    {#if st.mics?.length}
      <section>
        <h3 class="section-title">Erkennung</h3>
        <div class="group mics">
          {#each st.mics as m}
            <div class="mic" class:speaking={m.speaking} class:active={st.activeKey === m.key}>
              <span class="mname">{m.label}</span>
              <div class="mbar">
                {#if m.level !== null}
                  <div class="mfill" style="width: {Math.min(100, (m.level / 126) * 100)}%"></div>
                  {#if m.floor !== null}<div class="mfloor" style="left: {Math.min(100, ((m.floor + 8) / 126) * 100)}%" title="Schwelle"></div>{/if}
                {/if}
              </div>
              <span class="mstate">
                {#if !m.on}<em class="warn">Aus</em>
                {:else if !m.faderOpen}<em class="warn">Fader zu</em>
                {:else if m.speaking}<em class="ok">Spricht</em>
                {:else}<em>Ruhig</em>{/if}
              </span>
            </div>
          {/each}
        </div>
        <p class="hint t-footnote">{st.metersAvailable ? "Pegel am Pult über dem eigenen Grundrauschen. Der Strich ist die Schwelle." : "Ohne Pult-Pegel zählt nur das einzige offene Mikro."}</p>
      </section>
    {/if}

    <!-- 1 Measurement -->
    <section>
      <h3 class="step"><span class="stepn">1</span>Messung in der Raummitte</h3>
      <div class="group">
        {#if !RoomMeter.supported}
          <p class="t-callout"><b>Für das Mikrofon braucht dieses Gerät die sichere Verbindung.</b> Einmalig einrichten:</p>
          <ol class="steps">
            <li><a href={certUrl}>QLMix-Zertifikat laden</a> und „Erlauben“ tippen.</li>
            <li>Einstellungen → Allgemein → <i>VPN und Geräteverwaltung</i> → „QLMix Local CA“ → Installieren.</li>
            <li>Einstellungen → Allgemein → Info → <i>Zertifikatsvertrauenseinstellungen</i> → „QLMix Local CA“ einschalten.</li>
            <li>Dann diese Seite sicher öffnen.</li>
          </ol>
          {#if httpsUrl}<a class="pill primary wide" href={httpsUrl}><Icon name="lock" size={16} /> Sicher öffnen</a>{/if}
        {:else}
          <button class="pill wide" class:lit={measuringHere} aria-pressed={measuringHere} onclick={toggleMeasure}>
            {measuringHere ? "Dieses Handy misst – tippen zum Beenden" : "Mit diesem Handy messen"}
          </button>
          {#if measureError}<p class="err" role="alert">{measureError}</p>{/if}
        {/if}

        <div class="meter" aria-hidden="true">
          <div class="bar" style="width: {pct(st.room.level ?? localLevel)}%"></div>
          {#if st.room.floor !== null}<div class="mark floor" style="left: {pct(st.room.floor)}%"></div>{/if}
          {#if st.room.speech !== null}<div class="mark speech" style="left: {pct(st.room.speech)}%"></div>{/if}
          {#if st.room.target !== null}<div class="mark target" style="left: {pct(st.room.target)}%"></div>{/if}
        </div>
        <dl class="legend num">
          <div><dt>Jetzt</dt><dd>{fmt(st.room.level ?? localLevel)}</dd></div>
          <div><dt><i class="k speech"></i>Sprache</dt><dd>{fmt(st.room.speech)}</dd></div>
          <div><dt><i class="k target"></i>Ziel</dt><dd>{fmt(st.room.target)}</dd></div>
          <div><dt><i class="k floor"></i>Ruhe</dt><dd>{fmt(st.room.floor)}</dd></div>
        </dl>
        {#if st.feedback}<p class="err" role="alert"><Icon name="warning" size={15} /> Rückkopplung erkannt</p>{/if}
      </div>
      <p class="hint t-footnote">
        {#if auto.measuring && !measuringHere}Ein anderes Gerät misst gerade. {/if}
        Handy in die Mitte des Raums legen, Bildschirm an und QLMix im Vordergrund lassen.
      </p>
    </section>

    <!-- 2 Target -->
    <section>
      <h3 class="step"><span class="stepn">2</span>Ziel-Lautstärke</h3>
      <div class="group">
        <button class="pill wide" class:primary={cfg.reference === null && st.room.speech !== null} onclick={() => store.autoAction("reference")}>So soll es klingen</button>
        {#if store.autoError && store.autoErrorAction === "reference"}<p class="err" role="alert">{store.autoError}</p>{/if}
        {#if store.autoOk}<p class="okmsg"><Icon name="check" size={15} /> {store.autoOk}</p>{/if}
        <div class="ctrl">
          <div class="lbl"><span>Leiser</span><b class="num">{cfg.offset > 0 ? "+" : ""}{cfg.offset.toFixed(1)} dB</b><span>Lauter</span></div>
          <input type="range" min="-10" max="10" step="0.5" value={cfg.offset} aria-label="Ziel anpassen"
            onchange={(e) => store.autoAction("config", { offset: Number(e.currentTarget.value) })} />
        </div>
      </div>
      <p class="hint t-footnote">Drücken, während eine Person normal spricht und es im Raum gut klingt – das wird das Ziel.
        {#if cfg.reference !== null}Aktuell {cfg.reference.toFixed(1)} dB.{/if}</p>
    </section>

    <!-- 3 Channels -->
    <section>
      <h3 class="step"><span class="stepn">3</span>Sprecher-Mikrofone</h3>
      <div class="chgrid">
        {#each inputs as c}
          {@const sel = selected(c)}
          {@const corr = st.corrections[`${c.kind}:${c.index}`]}
          <button class="ch" class:sel class:active={st.activeKey === `${c.kind}:${c.index}`} aria-pressed={sel} onclick={() => toggleChannel(c)}>
            <span class="n">{channelLabel(c)}</span>
            <b>{name(c)}</b>
            {#if sel && corr !== undefined}<span class="corr num">{corr > 0 ? "+" : ""}{corr.toFixed(1)} dB</span>{/if}
          </button>
        {/each}
      </div>
      <p class="hint t-footnote">Nur diese Kanäle darf die Automatik bewegen (z. B. Kanzel, Rednerpult, Funkmikros) – keine Instrumente oder Gesang.</p>
    </section>

    <!-- 4 Limits -->
    <section>
      <h3 class="step"><span class="stepn">4</span>Grenzen</h3>
      <div class="group">
        <div class="ctrl">
          <div class="lbl"><span>Max. anheben</span><b class="num">+{cfg.maxBoost} dB</b></div>
          <input type="range" min="0" max="12" step="1" value={cfg.maxBoost} aria-label="Maximal anheben" onchange={(e) => store.autoAction("config", { maxBoost: Number(e.currentTarget.value) })} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Max. absenken</span><b class="num">−{cfg.maxCut} dB</b></div>
          <input type="range" min="0" max="20" step="1" value={cfg.maxCut} aria-label="Maximal absenken" onchange={(e) => store.autoAction("config", { maxCut: Number(e.currentTarget.value) })} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Fader nie über</span><b class="num">{cfg.ceiling > 0 ? "+" : ""}{cfg.ceiling} dB</b></div>
          <input type="range" min="-10" max="10" step="1" value={cfg.ceiling} aria-label="Fader-Obergrenze" onchange={(e) => store.autoAction("config", { ceiling: Number(e.currentTarget.value) })} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Tempo</span></div>
          <div class="segmented" role="radiogroup" aria-label="Tempo">
            {#each speeds as s}
              <button role="radio" aria-checked={cfg.speed === s.v} class:sel={cfg.speed === s.v} onclick={() => store.autoAction("config", { speed: s.v })}>{s.l}</button>
            {/each}
          </div>
        </div>
      </div>
    </section>

    <p class="t-footnote">Die Automatik regelt nur, wenn ein ausgewähltes Mikro aktiv ist und gesprochen wird. Bei Musik bitte ausschalten.
      Fader, die du selbst bewegst, lässt sie 20 Sekunden in Ruhe. Bei Rückkopplung wird sofort um 3 dB abgesenkt.</p>
  {/if}
</Sheet>

<style>
  .hero { display: flex; flex-direction: column; gap: var(--s3); }
  .status { display: flex; gap: var(--s3); align-items: flex-start; }
  .stext { display: flex; flex-direction: column; gap: 2px; }
  .sdot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--label-3); }
  .status.ok .sdot { background: var(--on); box-shadow: 0 0 0 4px rgba(48, 209, 88, 0.18); }
  .status.warn .sdot { background: var(--warn); box-shadow: 0 0 0 4px rgba(255, 179, 64, 0.16); }
  .cta { min-height: 52px; font-size: var(--fs-headline); }
  .todo {
    padding: var(--s3) var(--s4);
    border-radius: var(--r-sm);
    background: rgba(255, 179, 64, 0.08);
    box-shadow: inset 0 0 0 1px rgba(255, 179, 64, 0.28);
    font-size: var(--fs-callout);
    line-height: 20px;
  }
  .todo-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--warn); }
  .todo ul { margin: var(--s1) 0 0; padding-left: 20px; color: var(--label); }
  .err { display: flex; align-items: center; gap: 6px; color: var(--danger-text); font-size: var(--fs-footnote); line-height: 18px; }
  .okmsg { display: flex; align-items: center; gap: 6px; color: var(--on); font-size: var(--fs-footnote); }
  .hint { padding: var(--s2) var(--s1) 0; }

  .step { display: flex; align-items: center; gap: var(--s2); font: 600 var(--fs-headline) / 22px var(--font); margin-bottom: var(--s3); }
  .stepn {
    display: inline-grid; place-items: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--surface-3); color: var(--label-2);
    font-size: var(--fs-caption); font-weight: 700;
  }

  .steps { margin: 0; padding-left: 20px; font-size: var(--fs-callout); line-height: 22px; display: flex; flex-direction: column; gap: var(--s1); }

  .meter { position: relative; height: 12px; border-radius: 6px; background: var(--sunken); overflow: hidden; margin-top: var(--s1); }
  .bar { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #248a3d, var(--on)); transition: width 0.15s linear; }
  .mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; }
  .mark.floor, .k.floor { background: var(--label-3); }
  .mark.speech, .k.speech { background: var(--info); }
  .mark.target, .k.target { background: var(--label); }
  .mark.target { width: 3px; }
  .legend { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s2); margin: 0; }
  .legend div { display: flex; flex-direction: column; gap: 2px; }
  .legend dt { display: flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--label-2); }
  .legend dd { margin: 0; font-size: var(--fs-callout); font-weight: 600; }
  .k { width: 8px; height: 8px; border-radius: 2px; }

  .ctrl { display: flex; flex-direction: column; gap: var(--s1); }
  .lbl { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .lbl b { color: var(--label); font-weight: 600; }

  .chgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: var(--s2); }
  .ch {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    min-height: 56px; padding: var(--s2) var(--s3);
    border-radius: var(--r-sm);
    background: var(--surface-1);
    text-align: left;
    transition: background-color 120ms var(--ease), box-shadow 120ms var(--ease);
  }
  .ch:hover { background: var(--surface-2); }
  .ch .n { font-size: var(--fs-caption2); font-weight: 600; color: var(--label-2); }
  .ch b { font-size: var(--fs-footnote); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .ch.sel { background: rgba(0, 113, 227, 0.18); box-shadow: inset 0 0 0 1.5px var(--accent-text); }
  .ch.sel .n { color: var(--accent-text); }
  .ch.active { box-shadow: inset 0 0 0 1.5px var(--accent-text), 0 0 0 3px rgba(48, 209, 88, 0.55); }
  .ch .corr { font-size: var(--fs-caption); color: var(--label-2); }

  .mics { gap: var(--s2); }
  .mic { display: grid; grid-template-columns: minmax(70px, 110px) 1fr 72px; align-items: center; gap: var(--s3); font-size: var(--fs-callout); min-height: 28px; }
  .mic.active .mname { color: var(--on); font-weight: 600; }
  .mname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mbar { position: relative; height: 6px; border-radius: 3px; background: var(--sunken); overflow: hidden; }
  .mfill { position: absolute; inset: 0 auto 0 0; background: var(--surface-3); transition: width 0.1s linear; }
  .mic.speaking .mfill { background: var(--on); }
  .mfloor { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--label); }
  .mstate { text-align: right; font-size: var(--fs-footnote); }
  .mstate em { font-style: normal; color: var(--label-2); }
  .mstate em.ok { color: var(--on); font-weight: 600; }
  .mstate em.warn { color: var(--warn); font-weight: 600; }

  @media (max-width: 430px) {
    .legend { grid-template-columns: repeat(2, 1fr); row-gap: var(--s3); }
  }
</style>
