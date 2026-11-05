# QLMix – native macOS-Fernsteuerung für Yamaha QL/CL

SwiftUI-App (Swift 6, `Network.framework`, keine Fremdbibliotheken) zur Steuerung von Yamaha QL1/QL5
(und CL1/3/5) als Alternative zu StageMix.

## Protokoll – warum keine Wireshark-Dumps nötig sind

StageMix nutzt ein proprietäres Binärprotokoll. Die Pulte sprechen aber zusätzlich das
**Yamaha Remote Control Protocol (RCP)**: ein zeilenbasiertes Textprotokoll über **TCP-Port 49280**,
das auch Crestron/Q-SYS/Companion verwenden. Ein Handshake ist nicht nötig – Verbinden und Befehle senden genügt.

```
→ get MIXER:Current/InCh/Fader/Level 0 0
← OK get MIXER:Current/InCh/Fader/Level 0 0 -1000          (−10.00 dB, Einheit 0.01 dB, −32768 = −∞)
→ set MIXER:Current/InCh/Fader/On 0 0 0                    (Kanal 1 aus = Mute)
← NOTIFY set MIXER:Current/InCh/Fader/Level 3 0 -500 "-5.00"   (Änderung am Pult / durch andere Clients)
→ mtrstart MIXER:Current/Mix/PostOn 100
← NOTIFY mtr MIXER:Current/Mix/PostOn PostOn 7e 6a 00 …    (ein Hex-Byte pro Kanal, dB = Wert − 126)
→ ssrecall_ex MIXER:Lib/Scene 5
```

| Funktion | Adresse | x / y |
|---|---|---|
| Fader | `MIXER:Current/<InCh\|StInCh\|Mix\|Mtrx\|St\|DCA>/Fader/Level` | Kanal / 0 |
| ON (Mute) | `…/Fader/On` | Kanal / 0 |
| Name / Farbe | `…/Label/Name`, `…/Label/Color` | Kanal / 0 |
| Cue | `MIXER:Current/Cue/<Seg>/On` | Kanal / 0 |
| Sends | `MIXER:Current/InCh/ToMix/Level`, `…/ToMix/On` | Kanal / Mix |

Besonderheiten: `StInCh` hat 16 Einträge (L = 2n, R = 2n+1), `St` hat 3 (ST L, ST R, MONO).

## Projektstruktur

```
Sources/
  YamahaQLProtocol/   Tokenizer, Parser (RCPMessage), Encoder (RCPCommand), Adressen,
                      Fader-Kurve (FaderLevel), Farben, Meter, Zeilen-Framing
  YamahaQLNetwork/    ConsoleConnection (actor): NWConnection, Reconnect mit Backoff,
                      Keepalive (devstatus runmode), Totverbindungs-Erkennung
  QLMix/              SwiftUI-App (@Observable MixerStore, Strips, Fader, Meter, Log, Settings)
  QLSimulator/        Fake-Pult zum Testen ohne Hardware
Tests/                31 Swift-Testing-Tests (Protokoll, EQ-Adressen, EQ-Kurve)
scripts/make-app.sh   baut build/QLMix.app (Release, ad-hoc signiert)
```

## Bauen & Starten

```bash
swift test                      # Protokoll-Tests
./scripts/make-app.sh           # → build/QLMix.app
open build/QLMix.app
```

Oder `Package.swift` in Xcode öffnen und das Schema **QLMix** starten.

### Ohne Pult testen

```bash
swift run QLSimulator --animate     # Fake-QL5 auf 127.0.0.1:49280, bewegt zufällig Fader
```

Dann in der App `127.0.0.1` eintragen und verbinden.

## Am echten Pult

1. Mac per Ethernet ins Netz des Pults (Pult-IP steht unter SETUP → NETWORK; Mac braucht eine IP im selben Subnetz).
2. IP in der App eintragen → **Verbinden** (⌘K).
3. Beim ersten Start fragt macOS nach „Lokales Netzwerk“ – erlauben.

## Bedienung

* **Fader**: relatives Ziehen (Klick springt nie), ⌥ = fein, Scrollrad ±0,5 dB (⌥: 0,1 dB), Rechtsklick → 0 dB / −∞
* **Ebenen**: ⌘1 … ⌘9 · **Neu synchronisieren**: ⌘R · **Log**: ⌘L
* **Sends on Fader**: Rechts oben „Fader: Sends → MIX n“ – die Eingangsfader steuern dann den Monitormix
* **Name/Farbe**: Klick auf das Namensfeld
* **Szenen**: Nummer eingeben → Recall (mit Bestätigung)
* **Log-Fenster**: Live-Traffic, Filter, und eine Eingabezeile für beliebige RCP-Befehle

### EQ

* Klick auf die kleine EQ-Kurve im Kanalzug (oder ⌘E) öffnet rechts den EQ-Editor.
* 4 Bänder (LOW / LO-MID / HI-MID / HIGH), LOW und HIGH umschaltbar Bell ↔ Shelf, HPF, EQ ON, Flat.
* Knoten in der Kurve ziehen = Frequenz + Gain, Scrollrad = Q (⌥ fein), Doppelklick = 0 dB, ‹ › = Kanal wechseln.

**Wichtig:** Yamaha dokumentiert die EQ-Adressen für CL/QL nicht, und die bekannte Parameterliste eines CL/QL
enthält keinen EQ. Die App verwendet deshalb das Adressschema der neueren Yamaha-Pulte (RIVAGE/DM7):

```
MIXER:Current/InCh/PEQ/On                 MIXER:Current/InCh/PEQ/Band/Freq  ch band  (Hz × 10)
MIXER:Current/InCh/PEQ/LowShelving/On     MIXER:Current/InCh/PEQ/Band/Gain  ch band  (dB × 100)
MIXER:Current/InCh/PEQ/HighShelving/On    MIXER:Current/InCh/PEQ/Band/Q     ch band  (Q × 1000)
MIXER:Current/InCh/HPF/On                 MIXER:Current/InCh/HPF/Freq       ch 0     (Hz × 10)
```

Beim Verbinden prüft die App, ob das Pult darauf antwortet (Varianten `PEQ` und `EQ`). Falls nicht, zeigt der
EQ-Editor das an. Dann im EQ-Editor oder Log-Fenster **„Parameterliste auslesen“** klicken. Die App fragt damit alle
Parameter des Pults ab (`prminfo 0…999`, `scninfo`, `mtrinfo`) und speichert sie unter `~/Documents/QLMix/`.
Mit dieser Datei lässt sich das Mapping exakt anpassen (`Sources/YamahaQLProtocol/EQ.swift`, `EQSchema`).

Simulator ohne EQ testen: `swift run QLSimulator --no-eq`

## Bekannte Grenzen / ungeprüft

* Gegen echte Hardware noch nicht getestet – entwickelt gegen den Simulator und die
  dokumentierte Parameterliste (Companion `CLQL Parameters-1.txt`).
* RCP liefert auf CL/QL **nur Mix- und Matrix-Meter**, keine Eingangs-Meter.
* EQ-Adressen sind für CL/QL nicht bestätigt (siehe Abschnitt EQ).
* Die Fader-Kurve (Position ↔ dB) ist an Yamaha angelehnt, aber nicht 1:1 identisch.
