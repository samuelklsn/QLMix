# QLMix Web – Yamaha QL/CL vom iPhone steuern

Ein kleiner Server läuft auf einem Rechner im selben Netz wie das Pult (Mac, später auch Raspberry Pi)
und hält die Verbindung zum Pult. Jedes Gerät im WLAN – iPhone, iPad, Android, Laptop – öffnet einfach
die angezeigte Adresse im Browser.

```
iPhone / iPad ──WLAN──▶ Server (Mac, Port 8080) ──LAN──▶ Yamaha QL (Port 49280)
```

## Starten

Einmalig (im Ordner `web/`):

```bash
npm install
```

Starten – mit der IP deines Pults (steht am QL unter SETUP → NETWORK):

```bash
npm start -- --console 192.168.1.245
```

Die IP wird in `web/config.json` gespeichert. Danach genügt `npm start`.
Im Terminal erscheinen die Adresse für das Handy und ein QR-Code zum Scannen.

| Option | Bedeutung |
|---|---|
| `--console <IP>` | IP-Adresse des Pults |
| `--http-port 8080` | Port der Web-Oberfläche |
| `--pin 1234` | PIN abfragen, bevor jemand steuern darf (empfohlen in fremden WLANs) |
| `--no-connect` | Beim Start nicht automatisch verbinden |

Fragt macOS beim ersten Start, ob `node` eingehende Verbindungen annehmen darf: **Erlauben** –
sonst erreicht das iPhone den Server nicht.

### Als App auf dem iPhone

In Safari die Adresse öffnen → Teilen → **Zum Home-Bildschirm**. QLMix startet dann wie eine App im Vollbild.

## Dauerbetrieb auf einem Windows-PC

QLMix kann auf einem Windows-10/11-PC laufen, der sowieso an ist. Es startet dann automatisch mit Windows –
auch ohne Anmeldung, unsichtbar im Hintergrund und mit automatischem Neustart nach einem Fehler.

**Voraussetzung:** Der PC ist im selben Netzwerk wie das Pult (LAN-Kabel oder WLAN am selben Router).

1. **Dateien holen.** Eingabeaufforderung öffnen und eingeben:
   ```
   winget install --id Git.Git -e
   git clone https://github.com/samuelklsn/QLMix.git C:\QLMix
   ```
   (Alternativ [ZIP herunterladen](https://github.com/samuelklsn/QLMix/archive/main.zip) und nach `C:\QLMix` entpacken.
   Ausführliche Schritt-für-Schritt-Anleitung: [README im Hauptordner](../README.md#installation-auf-einem-windows-pc-empfohlen).)
2. **Installieren:** Im Explorer `C:\QLMix\web\windows\install.cmd` doppelklicken und die
   Administrator-Abfrage bestätigen. Das Skript fragt nach der **IP-Adresse des Pults**, installiert bei Bedarf
   Node.js, richtet den Autostart ein, gibt Port 8080 in der Firewall (nur fürs lokale Netz) frei und startet QLMix.
   Am Ende zeigt es die Adresse für das Handy an, z. B. `http://192.168.1.50:8080`.
3. **Energiesparmodus aus:** Einstellungen → System → Netzbetrieb und Energiesparen → Energiesparmodus **Nie**.
4. **Feste Adresse (empfohlen):** Im Router dem PC immer dieselbe IP zuweisen, damit sich die Handy-Adresse nicht ändert.

| Aufgabe | So geht's |
|---|---|
| Läuft QLMix? | Am PC `http://localhost:8080` öffnen · Protokoll: `C:\QLMix\web\qlmix.log` |
| Fehlersuche | `web\windows\diagnose.cmd` (Bericht: `qlmix-diagnose.txt` auf dem Desktop) |
| Update einspielen | `web\windows\update.cmd` doppelklicken (holt neuen Stand, baut neu, startet neu) |
| Pult-IP ändern | In QLMix unter ⚙︎ Einstellungen – oder `install.cmd` erneut ausführen |
| Autostart entfernen | `web\windows\uninstall.cmd` |
| Dienst ansehen | Windows „Aufgabenplanung“ → Aufgabe **QLMix** |

Läuft auf demselben PC der **QL Editor**, kommen sich beide bei der EQ-Verbindung in die Quere (siehe unten).

## Bedienung

* **Mischen**: Kanalfader, ON, CUE. Bänke 1–16 … 49–64, ST IN, MIX, MTX, DCA, Summe.
* **Monitor**: Mix oben auswählen – die Fader steuern dann die Sends auf diesen Mix (orange).
* **Kanalname antippen**: EQ (sobald verfügbar), Gain (Vorverstärker), Name und Farbe.
* **⚙︎ Einstellungen**: Pult-IP, Szenen aufrufen, Diagnose/Log, **Links für Musiker**.
* **Musiker-Links** (`/?mix=3`): zeigen nur den eigenen Monitormix; Gain, EQ und Einstellungen sind gesperrt.
  Jeder Musiker kann so seinen In-Ear-Mix selbst vom Handy aus einstellen.
* Fader bewegen sich **relativ** (Antippen springt nie). Mehrere Fader gleichzeitig mit mehreren Fingern gehen.

## Entwicklung

```bash
npm run dev      # Vite-Dev-Server (Port 5173); dazu in 2. Terminal: npm run serve
npm test         # Protokoll-Tests (node:test)
npm run check    # Typprüfung
```

Zum Testen ohne Pult: im Hauptordner `swift run QLSimulator --animate`, dann `npm start -- --console 127.0.0.1`.

Aufbau: `shared/rcp.ts` (Protokoll, von Server und Browser genutzt) · `server/` (Node, TCP ↔ WebSocket, Werte-Cache)
· `src/` (Svelte-Oberfläche).

## EQ (CL/QL)

Die offene Steuerschnittstelle (Port 49280) gibt bei CL/QL keinen EQ heraus. QLMix spricht für EQ und HPF
deshalb zusätzlich das Protokoll von QL Editor/StageMix: **MIDI-Parameter-Change-SysEx über TCP-Port 50000**.

```
F0 43 10 3E 19 01  <Element 2 Byte> <Index 2 Byte> <Kanal 2 Byte> <Wert 5 Byte, 32 Bit in 7-Bit-Gruppen>  F7   Schreiben
F0 43 30 3E 19 01  <Element> <Index> <Kanal>  F7                                                       Lesen
```

| Element | Bedeutung | Indizes |
|---|---|---|
| 67 / 90 / 107 / 121 | EQ Input / Mix / Matrix / Stereo | 2 = EQ an · 3/4 = LOW/HIGH-Typ · 8+4b / 9+4b / 10+4b = Q / Freq / Gain von Band b |
| 66 | HPF Input | 0 = an · 1 = Frequenz |

* Frequenz: Stufe 0 = 16 Hz … 124 = 20 kHz (1/12 Oktave) · Gain: 0,1 dB · Q: Stufe 0 = 16 … 44 = 0,10
* Kanalnummern: Mono-Eingänge 0…63, Stereo-Eingänge danach als L/R-Paare (QL5: 64…79); Stereo-Summe 0/1, Mono 2.
* Ermittelt aus einem Mitschnitt von QL Editor V5.8.1 und dessen Parametertabellen; geprüft an einem QL5 (Firmware V5.80a).

**Hinweise:**
* Das Pult antwortet pro IP-Adresse nur der zuletzt verbundenen Gegenstelle. Läuft der **QL Editor auf demselben
  Rechner** wie der QLMix-Server, kommen sich beide in die Quere – den Editor dann schließen. StageMix auf dem iPad stört nicht.
* Das Pult meldet EQ-Änderungen nicht von selbst. Der Server fragt deshalb den EQ des gerade geöffneten Kanals
  alle 1,5 Sekunden ab – Änderungen am Pult erscheinen mit kurzer Verzögerung.

## Dynamics und Premium Rack (CL/QL) – Stand: vorbereitet

Über das Editor-Protokoll (Port 50000) liest und schreibt QLMix auch:

* **Dynamics** jedes Kanals (Kanal antippen → Reiter „Dynamics“): Dynamics 1 (Gate/Ducking/Comp/Expander) und
  Dynamics 2 (Comp/Compander/De-Esser) der Eingänge, Dynamics der Mix-, Matrix- und Summenkanäle.
  Elemente 61/64 (Eingänge), 88 (Mix), 105 (Matrix), 119 (Stereo); Index 0 an, 1 Typ, 9 Attack, 10 Range,
  11 Hold, 12 Release/Decay, 13 Ratio, 14 Gain, 15 Knee, 16 Threshold.
* **Premium Rack** (Knopf „Rack“ oben): 8 Racks mit A/B-Seite, Modulname, Bypass und alle Parameter als Rohwerte.
  Element 705 („Kanal“ = Rack 0…7): Index 0–3 Name, 4/5 Bypass A/B, 6–73 Parameter A, 74–141 Parameter B;
  Element 132 = eingesetzter Modultyp.

Welche Rohwerte welchen Anzeigen am Pult entsprechen (z. B. Threshold-Stufe → dB, Portico-Regler → Parameter-Nummer),
wird einmalig am Pult abgeglichen. Bis dahin sind betroffene Anzeigen mit **≈** markiert.

### Kalibrierung am Pult (ca. 15–20 Minuten)

1. MacBook (oder ein anderer Rechner mit diesem Projekt) ins Netzwerk des Pults, QLMix starten.
2. In QLMix: ⚙︎ → **Rohwerte an**.
3. **Rack:** „Rack“ → z. B. Rack 1 (Portico 5043) öffnen. Am Pult nacheinander jeden Regler des Moduls drehen –
   unter „Kalibrierung – zuletzt geändert“ erscheint, welcher Parameter (A·n) sich ändert und mit welchem Wert.
   Für jede Reglerstellung Pult-Anzeige ↔ Rohwert notieren.
4. **Dynamics:** auf einem freien Kanal am Pult Threshold, Ratio, Attack, Release, Hold, Range, Gain, Knee und den Typ
   verändern und die Rohwerte in QLMix mit der Anzeige am Pult vergleichen.
5. Die Zuordnungen kommen nach `shared/ql-params.ts` (`DYNA_CONTROLS`, `RACK_MODULES`).
