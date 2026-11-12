<script lang="ts">
  import { type ChannelId, channelLabel, channelParamKey, channelsOf } from "../../shared/rcp.ts";
  import { store } from "./store.svelte.ts";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const auto = $derived(store.auto);
  const st = $derived(auto?.status);
  const cfg = $derived(auto?.config);
  const model = $derived(store.model);
  const inputs = $derived(model ? [...channelsOf(model, "input"), ...channelsOf(model, "stereoInput")] : []);

  // ------------------------------------------------------------ helpers
  const same = (a: ChannelId) => (b: ChannelId) => a.kind === b.kind && a.index === b.index;
  const selected = (c: ChannelId) => !!cfg?.channels.some(same(c));
  const isRoom = (c: ChannelId) => !!cfg?.roomMics.some(same(c));
  /** A channel is either a speaker mic or a room mic – choosing one role removes the other (server side). */
  function toggleChannel(c: ChannelId) {
    if (!cfg) return;
    store.autoAction("config", { channels: selected(c) ? cfg.channels.filter((x) => !same(c)(x)) : [...cfg.channels, c] });
  }
  // Channel lists show only the chosen channels until "Ändern" is tapped (72 inputs are a long list on a phone).
  let editRoom = $state(false);
  let editSpeakers = $state(false);
  const roomList = $derived(editRoom || !cfg?.roomMics.length ? inputs : inputs.filter(isRoom));
  const speakerList = $derived(editSpeakers || !cfg?.channels.length ? inputs : inputs.filter(selected));
  function toggleRoom(c: ChannelId) {
    if (!cfg) return;
    store.autoAction("config", { roomMics: isRoom(c) ? cfg.roomMics.filter((x) => !same(c)(x)) : [...cfg.roomMics, c] });
  }
  const name = (c: ChannelId) => {
    const v = store.get(channelParamKey(c, "name"));
    return typeof v === "string" && v ? v : channelLabel(c);
  };
  const pct = (db: number | null | undefined) => (db === null || db === undefined ? 0 : Math.max(0, Math.min(100, ((db + 80) / 80) * 100)));
  const fmt = (db: number | null | undefined) => (db === null || db === undefined ? "–" : `${db.toFixed(1)} dB`);
  const speeds = [{ v: 0.5, l: "Langsam" }, { v: 1, l: "Normal" }, { v: 2, l: "Schnell" }];
  const closeTimes = [15, 30, 60, 120];

  // Sliders: show the value while dragging, send it on release.
  type SliderKey = "offset" | "startLevel" | "minLevel" | "ceiling";
  let draft = $state<Partial<Record<SliderKey, number>>>({});
  const val = (k: SliderKey): number => draft[k] ?? cfg?.[k] ?? 0;
  const drag = (k: SliderKey, e: Event) => { draft[k] = Number((e.currentTarget as HTMLInputElement).value); };
  function commit(k: SliderKey, e: Event) {
    store.autoAction("config", { [k]: Number((e.currentTarget as HTMLInputElement).value) });
    delete draft[k];
  }
  const dbText = (db: number) => `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(Math.round(db * 10) / 10)} dB`;

  /** What is still missing before the automatic can start – shown as a checklist. */
  const missing = $derived.by(() => {
    const out: string[] = [];
    if (!cfg) return out;
    if (!cfg.roomMics.length) out.push("Unter 1 die Raum-Mikrofone antippen.");
    else if (!st?.room.fresh) out.push("Von den Raum-Mikros kommt kein Pegel – ist QLMix mit dem Pult verbunden?");
    if (cfg.reference === null) out.push("Unter 2 „So soll es klingen“ drücken, während jemand normal spricht.");
    if (!cfg.channels.length) out.push("Unter 3 die Sprecher-Mikrofone antippen.");
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
            {st.metersAvailable ? "erkannt über Pult-Pegel" : "keine Pult-Pegel"}
          </span>
          {#if st.event}<span class="event t-footnote"><Icon name="check" size={13} /> {st.event}</span>{/if}
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
                {#if m.blocked}<em class="warn">Von Hand zu</em>
                {:else if m.speaking && m.open}<em class="ok">Spricht</em>
                {:else if m.speaking}<em class="warn">Spricht · zu</em>
                {:else if m.closesIn !== null && m.closesIn <= cfg.closeAfter - 5}<em>Runter in {m.closesIn} s</em>
                {:else if m.fader === null}<em>Fader zu</em>
                {:else if !m.on}<em>Aus</em>
                {:else}<em>Offen</em>{/if}
              </span>
            </div>
          {/each}
        </div>
        <p class="hint t-footnote">Pegel am Pult vor EQ und ON – so wird Sprache auch bei ausgeschaltetem Kanal erkannt. Der Strich ist die Schwelle.</p>
      </section>
    {/if}

    <!-- 1 Room mics -->
    <section>
      <div class="stephead">
        <h3 class="step"><span class="stepn">1</span>Raum-Mikrofone</h3>
        {#if cfg.roomMics.length}<button class="pill" aria-expanded={editRoom} onclick={() => (editRoom = !editRoom)}>{editRoom ? "Fertig" : "Ändern"}</button>{/if}
      </div>
      <div class="chgrid">
        {#each roomList as c}
          {@const room = isRoom(c)}
          <button class="ch" class:sel={room} aria-pressed={room} onclick={() => toggleRoom(c)}>
            <span class="n">{channelLabel(c)}</span>
            <b>{name(c)}</b>
            {#if selected(c)}<span class="corr">Sprecher-Mikro</span>{/if}
          </button>
        {/each}
      </div>
      <div class="group roomlevel">
        <div class="meter" aria-hidden="true">
          <div class="bar" style="width: {pct(st.room.level)}%"></div>
          {#if st.room.floor !== null}<div class="mark floor" style="left: {pct(st.room.floor)}%"></div>{/if}
          {#if st.room.speech !== null}<div class="mark speech" style="left: {pct(st.room.speech)}%"></div>{/if}
          {#if st.room.target !== null}<div class="mark target" style="left: {pct(st.room.target)}%"></div>{/if}
        </div>
        <dl class="legend num">
          <div><dt>Jetzt</dt><dd>{fmt(st.room.level)}</dd></div>
          <div><dt><i class="k speech"></i>Sprache</dt><dd>{fmt(st.room.speech)}</dd></div>
          <div><dt><i class="k target"></i>Ziel</dt><dd>{fmt(st.room.target)}</dd></div>
          <div><dt><i class="k floor"></i>Ruhe</dt><dd>{fmt(st.room.floor)}</dd></div>
        </dl>
        {#if st.feedback}<p class="err" role="alert"><Icon name="warning" size={15} /> Raum plötzlich viel zu laut – Pegel reduziert</p>{/if}
      </div>
      <p class="hint t-footnote">Die Mikros, die im Raum hängen, messen, wie laut es ankommt. Ihr Kanal darf aus sein und der Fader unten –
        gemessen wird vor EQ und Fader. Mehrere werden gemittelt.</p>
    </section>

    <!-- 2 Target -->
    <section>
      <h3 class="step"><span class="stepn">2</span>Ziel-Lautstärke</h3>
      <div class="group">
        <button class="pill wide" class:primary={cfg.reference === null && st.room.speech !== null} onclick={() => store.autoAction("reference")}>So soll es klingen</button>
        {#if store.autoError && store.autoErrorAction === "reference"}<p class="err" role="alert">{store.autoError}</p>{/if}
        {#if store.autoOk}<p class="okmsg"><Icon name="check" size={15} /> {store.autoOk}</p>{/if}
        <div class="ctrl">
          <div class="lbl"><span>Leiser</span><b class="num">{val("offset") > 0 ? "+" : ""}{val("offset").toFixed(1)} dB</b><span>Lauter</span></div>
          <input type="range" min="-10" max="10" step="0.5" value={val("offset")} aria-label="Ziel anpassen"
            oninput={(e) => drag("offset", e)} onchange={(e) => commit("offset", e)} />
        </div>
      </div>
      <p class="hint t-footnote">Drücken, während eine Person normal spricht und es im Raum gut klingt – das wird das Ziel für alle Sprecher-Mikros.
        {#if cfg.reference !== null}Aktuell {cfg.reference.toFixed(1)} dB.{/if} Nach einer Gain-Änderung an den Raum-Mikros bitte neu festlegen.</p>
    </section>

    <!-- 3 Channels -->
    <section>
      <div class="stephead">
        <h3 class="step"><span class="stepn">3</span>Sprecher-Mikrofone</h3>
        {#if cfg.channels.length}<button class="pill" aria-expanded={editSpeakers} onclick={() => (editSpeakers = !editSpeakers)}>{editSpeakers ? "Fertig" : "Ändern"}</button>{/if}
      </div>
      <div class="chgrid">
        {#each speakerList as c}
          {@const sel = selected(c)}
          {@const learned = cfg.learned[`${c.kind}:${c.index}`]}
          {@const limit = cfg.limits?.[`${c.kind}:${c.index}`]}
          <button class="ch" class:sel class:active={st.activeKey === `${c.kind}:${c.index}`} aria-pressed={sel} onclick={() => toggleChannel(c)}>
            <span class="n">{channelLabel(c)}</span>
            <b>{name(c)}</b>
            {#if sel && learned !== undefined}<span class="corr num">gemerkt {dbText(learned / 100)}</span>{/if}
            {#if sel && limit !== undefined}<span class="corr warn num">Pfeifgrenze {dbText(limit / 100)}</span>{/if}
            {#if isRoom(c)}<span class="corr">Raum-Mikro</span>{/if}
          </button>
        {/each}
      </div>
      <p class="hint t-footnote">Nur diese Kanäle darf die Automatik einschalten und bewegen (z. B. Kanzel, Rednerpult, Funkmikros) – keine Instrumente oder Gesang.
        Die Automatik merkt sich pro Mikro, bei welcher Faderstellung die Lautstärke gepasst hat.</p>
    </section>

    <!-- 4 Rules -->
    <section>
      <h3 class="step"><span class="stepn">4</span>Regeln</h3>
      <div class="group">
        <div class="ctrl">
          <div class="lbl"><span>Erstes Öffnen auf</span><b class="num">{dbText(val("startLevel"))}</b></div>
          <input type="range" min="-30" max="5" step="1" value={val("startLevel")} aria-label="Faderstellung beim ersten Öffnen" oninput={(e) => drag("startLevel", e)} onchange={(e) => commit("startLevel", e)} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Fader nie unter</span><b class="num">{dbText(val("minLevel"))}</b></div>
          <input type="range" min="-40" max="-5" step="1" value={val("minLevel")} aria-label="Fader-Untergrenze" oninput={(e) => drag("minLevel", e)} onchange={(e) => commit("minLevel", e)} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Fader nie über</span><b class="num">{dbText(val("ceiling"))}</b></div>
          <input type="range" min="-10" max="10" step="1" value={val("ceiling")} aria-label="Fader-Obergrenze" oninput={(e) => drag("ceiling", e)} onchange={(e) => commit("ceiling", e)} />
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Fader runter, wenn niemand spricht, nach</span></div>
          <div class="segmented" role="radiogroup" aria-label="Fader runter nach Stille">
            {#each closeTimes as t}
              <button role="radio" aria-checked={cfg.closeAfter === t} class:sel={cfg.closeAfter === t} onclick={() => store.autoAction("config", { closeAfter: t })}>{t < 60 ? `${t} s` : `${t / 60} min`}</button>
            {/each}
          </div>
        </div>
        <div class="ctrl">
          <div class="lbl"><span>Tempo</span></div>
          <div class="segmented" role="radiogroup" aria-label="Tempo">
            {#each speeds as s}
              <button role="radio" aria-checked={cfg.speed === s.v} class:sel={cfg.speed === s.v} onclick={() => store.autoAction("config", { speed: s.v })}>{s.l}</button>
            {/each}
          </div>
        </div>
        {#if Object.keys(cfg.learned).length > 0}
          <button class="pill" onclick={() => store.autoAction("forget")}>Gemerkte Faderstellungen vergessen</button>
        {/if}
        {#if Object.keys(cfg.limits ?? {}).length > 0}
          <button class="pill" onclick={() => store.autoAction("forgetLimits")}>Pfeifgrenzen zurücksetzen</button>
        {/if}
      </div>
    </section>

    <p class="t-footnote">Spricht jemand deutlich in ein ausgewähltes Mikro, schaltet die Automatik es ein und zieht den Fader sofort auf die gemerkte Stellung.
      Danach regelt sie nach dem Pegel der Raum-Mikros. Spricht in ein Mikro länger niemand, geht sein Fader ganz runter.
      Bewegst du einen Fader selbst, merkt sie sich die Stellung und macht nach 5 Sekunden weiter. Schaltest du ein Mikro aus, während jemand hineinspricht, bleibt es aus.
      Pfeift es, nimmt sie das Mikro sofort 6 dB zurück und merkt sich eine Pfeifgrenze, über die es nicht mehr geht. Bei Musik bitte ausschalten.</p>
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
  .event { display: flex; align-items: center; gap: 4px; color: var(--on); margin-top: 2px; }
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


  .meter { position: relative; height: 12px; border-radius: 6px; background: var(--sunken); overflow: hidden; margin-top: var(--s1); }
  .bar { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #248a3d, var(--on)); transition: width 0.15s linear; }
  .mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; }
  .mark.floor, .k.floor { background: var(--label-3); }
  .mark.speech, .k.speech { background: var(--info); }
  .mark.target, .k.target { background: var(--label); }
  .mark.target { width: 3px; }
  .roomlevel { margin-top: var(--s3); }
  .legend { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s2); margin: 0; }
  .legend div { display: flex; flex-direction: column; gap: 2px; }
  .legend dt { display: flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--label-2); }
  .legend dd { margin: 0; font-size: var(--fs-callout); font-weight: 600; }
  .k { width: 8px; height: 8px; border-radius: 2px; }

  .ctrl { display: flex; flex-direction: column; gap: var(--s1); }
  .lbl { display: flex; justify-content: space-between; font-size: var(--fs-footnote); color: var(--label-2); }
  .lbl b { color: var(--label); font-weight: 600; }

  .stephead { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s3); }
  .stephead .step { margin-bottom: 0; }
  .chgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: var(--s2); }
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
  .ch .corr.warn { color: var(--warn); }
  .ch .corr { font-size: var(--fs-caption); color: var(--label-2); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

  .mics { gap: var(--s2); }
  .mic { display: grid; grid-template-columns: minmax(70px, 110px) 1fr 96px; align-items: center; gap: var(--s3); font-size: var(--fs-callout); min-height: 28px; }
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
