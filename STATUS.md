# STATUS – QLMix

Stand: 2026-11-12 · Version **1.7.0** veröffentlicht (Release `v1.7.0`)

## Fertig

**Mac-App (Swift, 1.0)**
- RCP-Steuerung: Fader, ON, Namen, Farben, Meter, Szenen.
- Simulator (RCP + SysEx + simulierte Meter + Talker).
- PDF-Anleitung `docs/QLMix-Anleitung.pdf`.

**Web-Version**
- Server (Node) mit Verbindung zum Pult über RCP 49280 und SysEx 50000; HTTP 8080 und HTTPS 8443 mit lokaler CA.
- Mixer:
  - Ebenen 1–16 … 49–64, ST IN, MIX, MTX, DCA, Summe.
  - ON, CUE, Fader mit Metern.
  - Monitor-Modus (Sends on Fader), Musiker-Links `/?mix=N`.
  - PIN, PWA.
- EQ und HPF über das Editor-Protokoll, am echten QL5 verifiziert (Test an CH 64, danach zurückgesetzt).
- Gain, Name, Farbe, Szenenaufruf mit Bestätigung, Diagnose-Log, Rohwerte-Modus.
- Dynamics (Gate, Kompressor …) und Premium Rack (Bypass A/B, Rohwerte, Kalibrierhilfe „zuletzt geändert“): vorbereitet, Einheiten noch nicht abgeglichen.
- Windows-Betrieb: Installer, Updater, Diagnose (Firewall, Netzprofil, „Alle eingehenden blockieren“), Uninstaller; Autostart als SYSTEM.

**Raum-Automatik**
- 1.1.0: Messung per Handy-Mikro (HTTPS nötig), Ziel „So soll es klingen“, Grenzen, Tempo, Rückkopplungsschutz.
- 1.1.1: Start-Knopf zeigt eine Checkliste, was noch fehlt.
- 1.1.2: Erkennung nach Abstand zum eigenen Grundrauschen; Meldung bei „Fader zu“ oder „Kanal aus“; Live-Anzeige „Erkennung“.

**1.2.0: neues Design nach Apple-HIG**
- Design-System in `app.css`.
- Gemeinsame `Sheet`- und `Icon`-Komponenten.
- Lesbarkeit und Kontrast verbessert, Fader per Tastatur bedienbar, ARIA.
- README mit neuen Screenshots (`docs/img/web/`).

**1.3.0**
- Kanal-Bereich neben dem Mischpult auf iPad/Computer, das Mischpult bleibt sichtbar und live.
- Kanal-Kopf mit Live-Pegel, Fader, ON, CUE und Gain direkt über EQ/Dynamics.
- Eingangspegel für alle Kanalzüge (vorher am echten QL keine Eingangs-Meter, weil RCP sie nicht liefert).
- Spitzenwert-Anzeige, Doppeltippen = 0 dB, Feinmodus beim langsamen Ziehen, Wischen zum Kanalwechsel.
- Diagnose „Fader-Ebenen vom Pult lesen“ (Custom Fader Bank) in den Einstellungen.
- README-Screenshots erneuert.

**1.4.0: Raum-Automatik öffnet Mikros selbst**
- Eine Ziel-Lautstärke für alle Sprecher-Mikros.
- Spricht jemand deutlich (≥ 12 dB über dem eigenen Grundrauschen, 6 dB lauter als alle anderen, 0,5 s), wird der Kanal eingeschaltet und der Fader auf die gemerkte Stellung (sonst −10 dB) gezogen.
- Gemerkte Faderstellung pro Mikro (`autolevel.learned` in `config.json`), aus „passt“-Momenten und Handgriffen.
- Mikros, die die Automatik geöffnet hat, werden nach Stille (Standard 30 s) wieder in den alten Zustand gebracht.
- Feste Grenzen statt relativ zur Startstellung: Fader nie unter −20 dB / nie über +5 dB.
- Behoben: Rundung des Pults galt als Handgriff (20 s Pause); Grundrauschen der Mikros wanderte bei langen Reden mit.
- Von Hand ausgeschaltet während jemand spricht → bleibt aus, bis 10 s Ruhe.
- Im Simulator end-to-end geprüft (aus → ein, −∞ → −10 dB → Feinregeln, Stummschalten von Hand).

**1.5.0: Raum-Mikros statt Handy**
- Grund: Samuel testete 1.4 ohne Handy-Messung → Mikro ging auf −10 dB, aber nichts wurde nachgeregelt. Er will kein Handy, sondern die Raum-Mikros am Pult.
- Raumpegel = Leistungsmittel der gewählten Raum-Mikros (`roomMics`), Meterpunkt 1 (vor EQ/Fader), raw − 126 = dBFS.
- Handy-Messung komplett entfernt (`room-meter.ts`, WS `room`, Zertifikats-Anleitung).
- Rückkopplungsschutz jetzt: Raum ≥ 1 s ohne Pause > Ziel + 10 dB → −3 dB.
- Ohne Pult-Pegel wartet die Automatik (vorher: „einziges offenes Mikro“ geraten).
- Fader bewegt sich höchstens `speed` dB/s, auch nach einer Pause.
- Kanal-Listen zeigen nur gewählte Kanäle, „Ändern“ klappt alle 72 auf.
- Simulator: `--room <n>` simuliert ein Raum-Mikro (hört den Sprecher über die Anlage); Fehler behoben, dass nach Server-Neustart keine Meter mehr kamen.

**1.6.0: Pfeifschutz, Übernahme, schneller**
- Samuels Rückmeldung zu 1.5: funktioniert gut; beim Mikro-/Positionswechsel pfiff es; Handgriff stoppte die Automatik zu lange; Darstellung/Auswahl hakte.
- Pfeifen = Raum-Mikros UND ein offenes Sprecher-Mikro 1 s lang ohne Pause (Spanne ≤ 6 dB), Raum über Ziel + 3 dB → −6 dB, Grenze = Stellung − 3 dB (`limits`), 10 s kein Anheben/Öffnen. Applaus/Musik bewegen das Sprecher-Mikro nicht gleichmäßig → kein Auslösen (Test).
- Fader aller Sprecher-Mikros gehen nach `closeAfter` s Stille auf −∞ (ON bleibt). Zählt ab dem Start, also auch für vorher von Hand geöffnete Mikros.
- Öffnen nach 0,25 s (vorher 0,5 s), direkt auf die gemerkte Stellung (höchstens Pfeifgrenze).
- Handgriff: 5 s Pause (vorher 20 s), Stellung wird gemerkt.
- EQ automatisch gegen Pfeifen: nicht möglich, weil das Pult nur Pegel liefert (keine Frequenzen).
- UI: Auswahl wirkt sofort (lokal, ohne auf den Server zu warten), Regler zeigen den Wert beim Ziehen, Pfeifgrenze an den Kacheln, „Pfeifgrenzen zurücksetzen“.

**1.7.0: unbeaufsichtigter Betrieb**
- Samuels Rückmeldung zu 1.6: zu empfindlich (Vorbeilaufen öffnet), Chor/Gemeindegesang darf nicht öffnen, ständiges Nachregeln klingt komisch. Muss ohne Techniker laufen (Fernbedienung über Samuels VPN – dafür nichts zu bauen).
- Ein Knopf: `running` wird gespeichert, nach Server-Neustart läuft die Automatik weiter (im Simulator geprüft).
- Pro Mikro gelernt (`profiles`): normaler Sprechpegel (dBFS) und Summe Mikropegel + Fader für die Ziel-Lautstärke. Erstes Einmessen über die Raum-Mikros, danach Regelung am Mikro selbst: neuer Sprecher → einmal einstellen (3 dB/s, 4 s), dann nur bei > 3 dB Abweichung über 10 s langsam (speed × 0,5 dB/s). Raum-Mikros ziehen die Summe nur nach, wenn der Fader ruht (0,15 dB/s). Handgriff setzt die Summe fest (`manual`).
- Öffnen: Pegel nahe am gelernten Sprechpegel (Empfindlichkeit −8/−12/−16 dB; ohne Profil +24/+20/+16 dB über Rauschen), ≥ 50 % der Messwerte in 0,8 s, 1000/700/450 ms anhaltend. Schritte/Klopfen und Gemeindegesang öffnen nicht (Tests).
- Musik: andere Eingänge ≥ 15 dB über eigenem Rauschen und ≥ −50 dBFS in ≥ 40 % von 3 s → Musik (4 s Nachlauf). Dann nur direkter Gesang öffnet, keine Regelung, Pfeifschutz erst ab Ziel + 10 dB.
- Notaus, Verlauf (40 Einträge), Zustandsanzeige Pult/Pegel/Raum-Mikros.
- Behoben: Gelerntes wurde bei durchgehender Rede nie gespeichert (Debounce) → jetzt höchstens alle 5 s gespeichert.

**Sonstiges**
- 15 Web-Tests grün, `svelte-check` 0 Fehler.

## In Arbeit

- 1.7.0 auf dem Windows-PC einspielen und am echten Pult testen (Einlernen, Musik-Erkennung, Neustart).
- Die Raum-Automatik ist in der **Testphase** (Badge „Test“ im UI). Der Nutzer testet sie im echten Raum.

## Nächste Schritte

- **Custom Fader Bank fertig bauen.** Samuel drückt am echten Pult „Fader-Ebenen vom Pult lesen“ und schickt das Ergebnis plus Foto der Custom-Ebene. Daraus den Aufbau ableiten, dann eigene Ebenen in der Bank-Leiste anzeigen und bei Änderungen am Pult nachladen.
  - Offene Frage an Samuel: Meint er die Custom Fader Bank (pro Benutzer), oder eine Reihenfolge pro Szene? Er hat es noch nicht beantwortet.
- **Samuel fragen, welche Funktionen ihm am meisten fehlen.** Vorschläge waren Mute-Gruppen, Pan, Sends eines Kanals auf alle Mixe, Szenen speichern. Er hat noch nicht geantwortet.

- 1.2.0 auf dem Windows-PC einspielen (`update.cmd`) und am echten Pult und iPhone prüfen. Die Rückmeldung des Nutzers steht noch aus.
- **Raum-Automatik (1.7) im echten Raum testen.**
  - Musik-Erkennung: Welche Kanäle zählen fälschlich als Musik (z. B. ein nicht ausgewähltes Sprechermikro)? → unter „Musik-Erkennung“ ausnehmen.
  - Öffnet es zu spät/zu früh? Empfindlichkeit anpassen; Schwellen in `autolevel.ts` (`OPEN_BELOW_SPEECH`, `CONFIRM_MS`).
- **Danach (1.8): EQ-Kerben gegen Pfeifen über Dante Virtual Soundcard** (Plan mit Samuel besprochen: ffmpeg liest DVS im WDM-Modus, FFT, Kerbe in freiem PEQ-Band). Samuel muss prüfen, ob DVS lizenziert und im WDM-Modus ist.
  - Löst der Pfeifschutz rechtzeitig aus? Löst er fälschlich aus (z. B. lang gezogene Vokale)? Dann `STEADY_DB`/`FEEDBACK_WINDOW_MS` anpassen.
  - Offene Frage: Display-Fehler, den Samuel gesehen hat, ist nicht genau bekannt (Screenshot erbeten).
  - Welche Kanäle sind die Raum-Mikros? Liefern sie genug Pegel (Sprache deutlich über Ruhe)?
  - Prüfen, ob ausgeschaltete Mikros zuverlässig geöffnet werden und nicht durch Übersprechen.
  - Schwellen ggf. anpassen (`OPEN_EXCESS`, `DOMINANCE`, `CONFIRM_MS` in `autolevel.ts`).
  - Prüfen, ob die Kanzel jetzt erkannt wird.
  - Ziel-Lautstärke, Tempo und Grenzen praxisnah einstellen.
- **Dynamics abgleichen:**
  - Am Pult Regler drehen und die angezeigten Werte (dB, ms, Ratio) mit dem Pult vergleichen.
  - Danach in `ql-params.ts` `calibrated: true` setzen und die Umrechnung korrigieren.
  - Dafür muss der Mac im Pult-Netz sein.
- **Premium Rack abgleichen:**
  - Pro Modul (Portico 5033/5043, Dynamic EQ …) mit der Kalibrierhilfe ermitteln, welcher Parameter-Index welcher Regler ist.
  - Dann `RACK_MODULES` in `ql-params.ts` füllen; die Liste ist aktuell leer.
- Weitere Messpunkte der Eingangsmeter (nach EQ, nach Fader …) zuordnen. Dazu am Pult vergleichen.
- Optional: PDF-Anleitung auf die Web-Version umstellen. Sie beschreibt noch die Mac-App.

## Bekannte Probleme / Offene Fragen

- **Nur eine Verbindung pro IP:**
  - Das Pult bedient pro Client-IP nur die neueste Verbindung.
  - Ein QL Editor auf demselben PC wie der QLMix-Server bricht deshalb die EQ-Verbindung (und umgekehrt).
  - Workaround: Editor schließen oder auf einem anderen Rechner nutzen.
- Die Diagnose fragt bis zu ca. 36 000 Adressen ab (im Simulator ca. 20 s). Am echten Pult ist noch nicht getestet, ob das die Verbindung kurz bremst.
- Das Pult pusht EQ-Änderungen nicht. Der Server fragt ab, daher erscheinen Änderungen am Pult mit kurzer Verzögerung.
- Die Dynamics-Anzeigen sind **ungefähr** (markiert mit „≈“). Die Regler funktionieren, die Einheiten können abweichen.
- Raum-Automatik: Die Raum-Mikros hören auch Musik und Applaus. Bei Musik muss die Automatik aus sein.
  - Nach einer Gain-Änderung an den Raum-Mikros muss „So soll es klingen“ neu gesetzt werden.
- `web/package-lock.json` führt noch Version `1.0.0` (nur kosmetisch). TODO: klären, ob mit `npm install` angleichen.
- TODO: klären, ob die Mac-App (`Sources/QLMix`) weiter gepflegt oder als Legacy markiert werden soll.
- TODO: klären, ob die alten Mac-Screenshots in `docs/img/*.png` noch gebraucht werden. Sie werden nur von der PDF-Anleitung und `build_guide.py` verwendet, das ist aber nicht geprüft.
- Die Konsole meldet bei RCP-EQ „Pult beantwortet keine EQ-Befehle über RCP“. Das ist bei CL/QL normal, der EQ läuft über SysEx.
