# CLAUDE.md – QLMix

## Projekt

- **QLMix** ist eine Fernsteuerung für Yamaha-Digitalpulte der **QL-Serie** (QL1, QL5) und **CL-Serie**, als Alternative zur iPad-App StageMix.
- **Nutzer:** Samuel (Besitzer, Techniker am Pult), seine Musiker (Monitormix am eigenen Handy) und Gemeinde-/Veranstaltungsbetrieb.
  - Das Pult des Nutzers ist eine **QL5, Firmware V5.80a**, mit fester IP `192.168.1.245`.
  - Es gibt ein Kanzel-Mikro, der Einsatz ist also u. a. in einer Kirche.
- **Hauptprodukt ist die Web-Version** (`web/`):
  - Ein Node-Server im Pult-Netz hält die Verbindung zum Pult.
  - Bedient wird im Browser (iPhone, iPad, Android, PC), installierbar als Home-Bildschirm-App.
- **Funktionen:**
  - Fader, ON, CUE für Eingänge, Stereo-Eingänge, MIX, MTX, DCA und Summe
  - Monitormixe (Sends on Fader), Musiker-Links `/?mix=N` (gesperrt auf einen Mix)
  - EQ und HPF mit grafischer Kurve, Gain, Name/Farbe, Szenenaufruf, Meter, optionale PIN
  - Dynamics (Gate/Kompressor …) und Premium Rack: **vorbereitet**, die Anzeige-Einheiten sind noch nicht am Pult abgeglichen
  - **Raum-Automatik** (seit 1.1, Testphase):
    - Seit 1.5 messen Raum-Mikros am Pult (`roomMics`, Pegel vor EQ über das Editor-Protokoll), wie laut es im Raum ankommt. Bis 1.4 maß ein Handy.
    - Der Server erkennt das sprechende Mikro (Pult-Pegel über dem eigenen Grundrauschen).
    - Er regelt dessen Fader auf eine Ziel-Lautstärke.
    - Seit 1.4: schaltet ausgeschaltete Mikros selbst ein und merkt sich pro Mikro die Faderstellung (`learned`).
    - Seit 1.6: übernimmt beim Start alle Sprecher-Mikros, Fader nach `closeAfter` s Stille auf −∞ (ON bleibt), Pfeifschutz mit Grenze pro Mikro (`limits`), Handgriff = 5 s Pause.
    - Seit 1.7: unbeaufsichtigter Betrieb. `running` bleibt über Neustarts an, Notaus (`panic`), Verlauf. Pro Mikro gelernt: Sprechpegel + „Summe“ (`profiles`: Mikropegel + Fader = Ziel); Regelung am Mikro selbst, einmal einstellen, dann nur > 3 dB langsam. Musik = andere Eingänge aktiv (`musicIgnore` ausnehmbar). Öffnen braucht anhaltende Sprache nahe dem gelernten Sprechpegel (`sensitivity`).
- **Produktivbetrieb:** auf einem Windows-PC des Nutzers, Autostart beim Booten.
- **Mac-App** (Swift, `Sources/QLMix`): der erste Prototyp. Sie kann kein EQ über RCP, weil das Pult EQ nicht über RCP anbietet.
  - TODO: klären, ob die Mac-App noch weiterentwickelt werden soll. Seit der Web-Version wurde sie nicht mehr angefasst.
- **Repo:** https://github.com/samuelklsn/QLMix (öffentlich, Branch `main`)
  - Aktuelle Version **1.7.0**, Releases als GitHub-Release mit Tag `vX.Y.Z`.

## Tech-Stack

**Web (Hauptprodukt)**
- Frontend: **Svelte 5** (Runes: `$state`, `$derived`, `$effect`, `$props`, Snippets) und TypeScript, gebaut mit **Vite 8**.
- Server: **Node ≥ 23.6** führt `.ts` direkt aus (Type Stripping, kein Build-Schritt).
  - **Keine** TS-Parameter-Properties (`constructor(private x)`), keine Enums und keine Namespaces, denn das kann Type Stripping nicht.
- Libraries:
  - `ws` (WebSocket)
  - `node-forge` (lokale CA und HTTPS-Zertifikat)
  - `qrcode-terminal` (QR-Code der Handy-Adresse im Terminal)
- Typprüfung mit `svelte-check`. **TypeScript ist auf 6.0.3 gepinnt**, weil TS 7 einen Peer-Konflikt mit svelte-check auslöst.
- Tests: `node --test` (eingebauter Test-Runner).
- Ports:
  - HTTP **8080**
  - HTTPS **8443** (Zertifikat aus der lokalen CA in `web/certs/`; war für die Handy-Messung bis 1.4 nötig, wird seit 1.5 nicht mehr gebraucht)

**Pult-Protokolle**
- **RCP** (Text, TCP **49280**):
  - Fader, ON, Namen, Farben, Szenen, Sends.
  - Pegel in 0,01 dB, −32768 = −∞.
  - Das Pult sendet NOTIFY-Meldungen.
- **Editor-Protokoll** (MIDI-SysEx über TCP **50000**, wie QL Editor/StageMix):
  - EQ, HPF, Dynamics, Premium Rack und Eingangsmeter.
  - Reverse-engineered aus einem Netzwerk-Mitschnitt und dem QL-Editor-Binary.
  - Element-Nummern und Werttabellen stehen in `web/shared/rcp.ts` und `web/shared/ql-params.ts`.
- Eigenheiten des Pults:
  - Es antwortet nur der **neuesten** Verbindung pro Client-IP. Ein QL Editor auf demselben PC wie der Server stört deshalb.
  - Es pusht EQ-Änderungen nicht, deshalb fragt der Server zyklisch ab.
  - Gelesene Werte hinken Schreibbefehlen hinterher. Der Server hält eingehende Werte nach einem Schreiben 1,5 s zurück.
  - **Meter:** RCP liefert auf CL/QL nur MIX- und MTX-Pegel (`METER_SOURCES`). Eingangspegel kommen über das Editor-Protokoll (Anfrage `INPUT_METER_REQUEST` alle 5 s, Punkt 1 = vor EQ). Der Server leitet sie seit 1.3 als `meters.input`/`meters.stereoInput` an die Browser weiter. Die übrigen 9 Messpunkte pro Kanal sind noch nicht zugeordnet.
  - **Element-Nummern:** Die n-te `k…`-Bezeichnung in der Namensliste des QL-Editor-Binarys ist Element n (geprüft an 61–862). Die Liste erzeugt `strings -a -t x "/Applications/QL Editor.app/Contents/MacOS/QL Editor"`, gefiltert auf ` k[A-Z][A-Za-z0-9_]+$` im Bereich 0x7b2a00–0x7b9000. Zeile n+1 = Element n.
  - **Custom Fader Bank:** Elemente 359–368 (`SetupCustomBlock…CL5/CL3/CL1`) und 517–533 (`BackupCustomFader…`, `BackupCustomBlock…`), stehen in `CUSTOM_FADER_ELEMENTS`. Der Aufbau (Index/Kanal/Wert) ist noch unbekannt. Die Diagnose in den Einstellungen liest ihn aus (`QLLink.probe`, Ergebnis auch in `web/faderbank-probe.txt`).

**Swift (Mac-App und Simulator)**
- SwiftPM, Swift 6, macOS 15.
- Targets:
  - `YamahaQLProtocol` (rein, plattformunabhängig)
  - `YamahaQLNetwork` (Network.framework)
  - `QLMix` (SwiftUI-App)
  - `QLSimulator` (falsches Pult)
  - Tests
- **QLSimulator** ist das zentrale Entwicklungswerkzeug: Er simuliert RCP und SysEx inklusive Metern und Talker.

**Deployment**
- Windows-PC: Skripte in `web/windows/` (`install`, `update`, `diagnose`, `uninstall`, jeweils `.cmd` + `.ps1`).
  - Geplante Aufgabe „QLMix“ startet beim Booten als SYSTEM.
  - Firewall-Regel „QLMix Web“ für 8080 und 8443, nur private IP-Bereiche.
  - Installiert wird nach `C:\QLMix` per `git clone`, alternativ als ZIP von `/archive/main.zip`.
  - Update: `C:\QLMix\web\windows\update.cmd` (`git pull`, Build, Neustart).
- `.ps1` und `.cmd` müssen **UTF-8 mit BOM und CRLF** sein und mit PowerShell 5.1 laufen.
  - In PowerShell `${var}:` statt `"$var:"` schreiben.
  - `.cmd`-Dateien müssen mit der OEM-Codepage funktionieren.

## Struktur

```
/                      SwiftPM-Paket (Package.swift), README.md (Haupt-Doku + Windows-Anleitung), CLAUDE.md, STATUS.md
Sources/QLMix/         Mac-App (SwiftUI): Model/, Views/
Sources/QLSimulator/   Pult-Simulator (RCP + SysEx)
Sources/YamahaQL*/     Protokoll- und Netzwerk-Bibliothek (Swift)
Tests/                 Swift-Tests (Protokoll, EQ)
scripts/make-app.sh    baut build/QLMix.app (Mac-App)
docs/                  QLMix-Anleitung.pdf + build_guide.py (Mac-App-Anleitung), img/ (alte Mac-Screenshots), img/web/ (README-Screenshots der Web-Version)
web/
  server/              Node-Server
    main.ts            HTTP/HTTPS, WebSocket, Config, Verteilung der Werte an Clients
    console-link.ts    RCP-Verbindung (Reconnect, Keepalive, Abfragen)
    ql-link.ts         SysEx-Verbindung Port 50000 (EQ, Dynamics, Rack, Meter)
    autolevel.ts       Regler der Raum-Automatik (rein, testbar)
    tls.ts             lokale CA + Server-Zertifikat
  shared/              von Server UND Browser genutzt
    rcp.ts             Kanal-Modell, Keys, Pegel/EQ-Umrechnung, QL-Tabellen, SysEx-Kodierung
    ql-params.ts       Dynamics- und Rack-Definitionen
  src/                 Svelte-Frontend
    App.svelte         Toolbar, Ebenen, Mixer, PIN-Bildschirm, Musiker-Modus
    app.css            Design-System (Tokens + globale Klassen)
    lib/               Komponenten und Store
  public/              icon.svg, manifest.webmanifest (PWA)
  test/                rcp.test.ts, autolevel.test.ts
  windows/             Windows-Installer/Updater/Diagnose
  config.json          Laufzeit-Config (gitignored): Pult-IP, Ports, PIN, autoConnect, autolevel
  certs/               lokale CA + Zertifikat (gitignored, wird automatisch erzeugt)
  dist/                Build-Ausgabe (gitignored)
```

**Komponenten in `web/src/lib/`**
- `Sheet.svelte`: gemeinsames Dialogfenster.
  - Props: `title`, `subtitle?`, `badge?`, `width?`, `docked?` (Seitenbereich statt Fenster), `onclose`, Snippets `header?` und `children`.
  - Escape schließt das Fenster.
- `Icon.svelte`: SVG-Icons (gear, close, back, forward, play, stop, rack, wave, lock, check, warning). Prop `name`, optional `size`.
- `Strip.svelte`: Kanalzug (Nummer, Namensschild, ON, CUE, Wert, Fader).
- `Fader.svelte`: Fader mit Skala, Meter (mit Spitzenwert), Maus/Touch/Rad/Tastatur. Doppeltippen = 0 dB, langsames Ziehen = Feinmodus (bis ¼ Weg), ⌥ = fein.
- `ChannelSheet.svelte`: Kanal-Fenster mit Tabs EQ, Dynamics und Kanal (Name, Farbe, Gain).
  - Auf iPad/Computer (≥ 1000 × 600) neben dem Mischpult angedockt (`docked`), der gewählte Kanalzug hat einen blauen Rahmen. Auf dem Handy erscheint es als Fenster von unten.
  - Wischen auf dem Kanalnamen wechselt den Kanal.
- `ChannelHead.svelte`: Kopf des Kanal-Bereichs mit Eingangs-/Ausgangspegel (Spitzenwert 1,5 s), waagrechtem Fader (Doppelklick = 0 dB), ON, CUE und Gain ±1 dB.
- `EqEditor.svelte`: Canvas-Kurve mit ziehbaren Punkten und Reglern pro Band.
- `DynamicsPanel.svelte`, `RackSheet.svelte`, `SettingsSheet.svelte`, `AutoSheet.svelte`.
- `store.svelte.ts`: zentraler Store (WebSocket, Werte-Map, Schreiben mit Touch-Schutz).

## Design-System

Alles ist in `web/src/app.css` definiert. Es basiert auf Apples Human Interface Guidelines; Version 1.2 hat das Design auf Basis eines Reviews mit dem `apple-design`-Skill überarbeitet.

**Grundsatz:** nur dunkles Design (Pult in dunklen Räumen). Die Oberfläche ist ruhig. Das einzige auffällige Element ist der Kanalzug mit farbigem Namensschild und leuchtender ON-Taste.

**Flächen** (von hinten nach vorne)

| Token | Wert |
|---|---|
| `--bg` | `#0b0c0f` |
| `--surface-1` | `#14161b` |
| `--surface-2` | `#1c1f26` |
| `--surface-3` | `#262a32` |
| `--sunken` | `#07080a` (Eingabefelder, Wertanzeigen, EQ-Grafik) |
| `--separator` | `rgba(255,255,255,.07)` |
| `--hairline` | `rgba(255,255,255,.12)` |

**Text**

| Token | Wert | Verwendung |
|---|---|---|
| `--label` | `#f2f3f5` | normaler Text |
| `--label-2` | `#a1a7b0` | Sekundärtext, ca. 7,5:1 |
| `--label-3` | `#7d838d` | nur Deko oder große Schrift, ca. 4,7:1 auf surface-1 |

**Farbrollen: eine Farbe, eine Bedeutung**

| Rolle | Wert | Bedeutung / Textfarbe darauf |
|---|---|---|
| `--accent` | `#0071e3` (Hover `#0a7cf0`) | Hauptaktion, Auswahl; weiße Schrift |
| `--accent-text` | `#409cff` | Links, Fokusring |
| `--on` | `#30d158` | „ist an“; Schrift `--on-ink #03240e` |
| `--cue` | `#ffd60a` | CUE/Vorhören; Schrift `--cue-ink #2b2400` |
| `--send` | `#ff9f0a` | Monitormix/Sends; Schrift `--send-ink #2a1700` |
| `--danger` | `#ff453a` | Stopp/Gefahr; weiße Schrift nur fett; Text-Variante `--danger-text #ff6961` |
| `--warn` | `#ffb340` | Warnungen |
| `--info` | `#64d2ff` | Infos, EQ-Kurve, Szenennummer |

- Grün nie für Aktionen verwenden, Blau nie für Zustände.
- **EQ-Bänder:** LOW `#ff5a4e`, LO-MID `#ffc23d`, HI-MID `#4fd66f`, HIGH `#5aa8ff`, HPF `#e6e8eb`.
- Kanalfarben: `COLOR_HEX` in `shared/rcp.ts` (Pult-Farben).
- Legacy-Aliase: `--text` = `--label`, `--muted` = `--label-2`. In neuem Code nicht verwenden.

**Schrift**
- Schriftart: System (`--font` = SF Pro Text, Inter, system-ui …). Daneben `--font-display` und `--font-mono`.
- Größen:

| Token | Größe | Stil / Klasse |
|---|---|---|
| `--fs-title` | 22 | `.t-title`, 700 |
| `--fs-headline` | 17 | `.t-headline`, 600 |
| `--fs-body` | 17 | |
| `--fs-callout` | 15 | `.t-callout` |
| `--fs-footnote` | 13 | `.t-footnote`, label-2 |
| `--fs-caption` | 12 | `.t-caption` |
| `--fs-caption2` | 11 | |

- **Minimum 11 px**, auch im Canvas.
- Zahlen mit `.num` (tabular-nums).
- Kontrast: mindestens 4,5:1 bis 17 px, 3:1 für fett oder ≥ 18 px.

**Abstände und Maße**
- 4-px-Raster: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 20, `--s6` 24, `--s8` 32.
- Radien: `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 22, `--r-full`.
- Steuerhöhen: `--h-control` 44 (Standard), `--h-compact` 36. Touch-Ziele mindestens 28 px.
- Kanalzug: `--strip-w` 76 (70 bei ≤ 430 px, 82 bei ≥ 1100 px), `--strip-gap`.

**Breakpoints**
- ≤ 430 px: Handy.
- ≥ 720 × 560: Sheets erscheinen als zentrierte Karte statt als Bottom-Sheet.
- ≥ 1000 × 600: Kanal-Bereich wird neben dem Mischpult angedockt.
- ≥ 1100 px: breite Kanalzüge.
- ≤ 430 px: Werkzeug-Knöpfe in der Toolbar zeigen nur Symbole.
- Der Ebenen-Umschalter in der Toolbar steht je nach Breite inline oder in einer eigenen Zeile.

**Globale Klassen**
- Text: `.t-*`, `.num`.
- Knöpfe:
  - `.pill` (36 px, surface-2) mit `.big` (44), `.wide` (volle Breite, 44)
  - Zustand/Rolle: `.lit` (an, grün), `.primary` (blau), `.danger`, `.ghost`
- Weitere Bausteine: `.icon-btn` (runder 36-px-Icon-Knopf), `.segmented` (Umschalter, Auswahl mit `.sel` auf dem Button), `.group` (Karte auf surface-1), `.section-title`, `.dot` (Status: `.connected`, `.connecting`, `.reconnecting`, `.failed`).
- Range-Slider sind global gestylt (4-px-Spur, 24-px-Daumen). Eingabefelder 44 px, Schrift ≥ 16 px (gegen iOS-Zoom).
- Fokus über `:focus-visible` mit Outline in accent-text. `prefers-reduced-motion` ist berücksichtigt.

**Regeln**
- Keine Hex-Farben in Komponenten, nur Tokens. Ausnahmen: Canvas-Zeichnung im EqEditor, Fader-Verläufe, Kanal-/EQ-Bandfarben.
- Keine Textzeichen als Icons (✕ ‹ › ▶ ■ ⚙︎); stattdessen `Icon.svelte`.
- Keine Transparenz (`opacity`), um Text zu dimmen. Für „getrennt“ lieber `saturate()`.
- Neue Dialoge immer mit `Sheet.svelte` bauen, Abschnitte mit `.section-title` und `.group`.
- Jeder Icon-Knopf braucht ein `aria-label`. Umschalter bekommen `aria-pressed`, Tabs `role="tab"` und `aria-selected`.

## Konventionen

- **Sprache:**
  - Oberfläche, Commit-Messages, README und Release-Notes auf **Deutsch**.
  - Code-Kommentare und Bezeichner auf Englisch.
- **Texte in der UI:**
  - Knöpfe sagen, was passiert („Szene aufrufen“, „So soll es klingen“).
  - Groß am Anfang („Aus“, „Spricht“, „Langsam“).
  - Fehler sagen, was zu tun ist.
- **Dateien:**
  - Svelte-Komponenten in PascalCase (`ChannelSheet.svelte`).
  - Module in kebab-case (`console-link.ts`).
  - Runes-Stores heißen `*.svelte.ts`.
- **Komponenten:**
  - `<script lang="ts">` mit `$props()` und typisiertem Interface, dann Markup, dann `<style>` (scoped, nutzt Tokens).
  - Callback-Props (`onclose`, `onopen`, `onselect`) statt Events.
- **State:**
  - Ein globaler `store` (Klasse mit `$state`) hält alle Pult-Werte als Map von `Key` (z. B. `MIXER:Current/InCh/Fader/Level 0 0`) auf den Wert.
  - Komponenten lesen mit `store.get` und `store.num`.
  - Schreiben mit `store.write(keys, value, immediate)`. Während des Ziehens `store.touch(keys, true/false)`, damit eingehende Werte den Regler nicht zurückspringen lassen.
  - EQ läuft über `store.eq()` und `store.writeEq()`.
- **Server → Browser:** WebSocket-JSON, Updates gebündelt.
  - Gemeinsame Logik (Keys, Umrechnungen) gehört nach `web/shared/`, nicht doppelt in Server und Client.
- **localStorage:**
  - Nur UI-Vorlieben mit Präfix `qlmix.` (mode, mix, bank, raw).
  - Im gesperrten Musiker-Modus (`?mix=N`) nichts speichern.
- **Pult-Werte nie raten.** Unbekannte Parameter sind im UI als „≈ nicht abgeglichen“ markiert (`calibrated: false` in `ql-params.ts`).
- **Tests:** reine Logik (Protokoll, Autolevel) bekommt Unit-Tests in `web/test/`.
- **Versionen:**
  - `web/package.json` → `version` hochzählen.
  - Release-Tag `vX.Y.Z` mit deutschen Release-Notes, inklusive Abschnitt „Update auf dem Windows-PC“.
- **Commits** enden mit `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Befehle

Alle Web-Befehle laufen im Ordner `web/`.

| Zweck | Befehl |
|---|---|
| Abhängigkeiten | `npm install` |
| Build + Server starten (Produktiv) | `npm start` |
| Nur Server (nach Build) | `node server/main.ts --console 192.168.1.245` (Optionen: `--http-port`, `--https-port`, `--pin`, `--console-port`, `--no-connect`) |
| Dev-UI mit Hot Reload | `npm run dev` (Vite, Proxy auf Server :8080, der parallel mit `npm run serve` laufen muss) |
| Build | `npm run build` (→ `web/dist`) |
| Typprüfung | `npm run check` |
| Tests | `npm test` bzw. `node --test test/*.test.ts` |
| Simulator bauen/starten (im Root) | `swift build --product QLSimulator && .build/debug/QLSimulator --no-eq --talker 1 --room 3` |
| Mac-App bauen (Root) | `./scripts/make-app.sh && open build/QLMix.app` |
| Swift-Tests (Root) | `swift test` |
| Release | `git push origin main`, dann `gh release create vX.Y.Z --target main --title "…" --notes-file -` |

Simulator-Optionen:
- `--no-eq`: kein EQ über RCP. So verhält sich das echte QL, und der Server nutzt dann SysEx; nur so erscheinen Dynamics und Rack.
- `--room <n>`: simuliertes Raum-Mikro, hört den Sprecher (`--talker`) über die Anlage (Fader + ON des Sprechers).
- `--model`, `--animate`, `--sysex-port`, `--firmware`, `--verbose`.

**Testaufbau mit Simulator: `web/config.json` NICHT überschreiben lassen.**
1. Der Server speichert CLI-Argumente in `config.json`. Deshalb vorher sichern: `cp web/config.json <scratchpad>/config.backup.json`.
2. Mit eigenen Ports starten, ohne den echten Server zu stören: `node server/main.ts --console 127.0.0.1 --http-port 8090 --https-port 8453`.
3. Danach Server und Simulator beenden und `config.json` zurückkopieren.
4. Die echte Pult-IP muss danach wieder `192.168.1.245` sein.

Screenshots für die README: headless Chrome per DevTools-Protokoll gegen den Simulator, Handy 390 × 844 @3x, Desktop 1440 × 900 @2x. Ablage in `docs/img/web/`.

## Meine Vorlieben

- **Immer auf Deutsch antworten.** Erklärungen einfach und praxisnah. Ich bin Techniker am Pult, kein Entwickler.
- **Selbstständig arbeiten:** „Mache alles, was du kannst, selber. Frage nur im Notfall.“ Fehlende Infos und Daten (z. B. Mitschnitte am Pult) erfragen, nicht raten.
- **Vor Commit, Push, Release und anderen nach außen wirkenden Schritten kurz fragen.** Das „Ja“ kam bisher immer, gilt aber jeweils nur für den konkreten Schritt.
- Bei größeren Features **erst erklären, wie es funktionieren soll, dann nach meinem „Go“ bauen** (so bei der Raum-Automatik).
- Neue Funktionen als **neue Version/Release auf GitHub**, immer **mit Update-Anleitung für den Windows-PC**.
- Die App soll **ohne MacBook** laufen. Der Windows-PC ist der Server und muss automatisch starten.
- Bedienung vor allem **vom iPhone** aus: EQ, Lautstärke, alles „wie am Pult“ (auch Kompressor, Dynamic EQ, Portico).
- Design: **modern, hochwertig, clean, im Stil von Apple.** Perfekte Abstände, saubere Typografie, klare Hierarchie. Keine iOS-App-Imitate auf der Webseite.
- README soll **aktuelle Screenshots** zeigen.
- Ich teste am echten Pult und melde Fehler mit Screenshots. Fixes dann als Patch-Release (1.1.1, 1.1.2 …).
- Nicht gewollt:
  - Änderungen an meiner Pult-Konfiguration ohne Rückfrage. Einen Send Kanzel→MIX1 wollte ich so lassen.
  - Dass der Testaufbau meine `config.json` überschreibt.

## Wo Details stehen

- `STATUS.md`: Stand, nächste Schritte, offene Fragen.
- `README.md`: Nutzer-Doku inklusive Windows-Installation, Update, Raum-Automatik und Fehlersuche.
- `web/shared/rcp.ts`, `web/shared/ql-params.ts`: alle Protokoll-Fakten (Element-Nummern, Indizes, Werttabellen) als Kommentare und Konstanten.
