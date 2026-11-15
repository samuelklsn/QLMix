# STATUS – QLMix

Stand: 2026-11-15 · Version **1.10.0** veröffentlicht (Release `v1.10.0`)

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

**1.8.0: nie zu stark verstärken**
- Samuels Rückmeldung zu 1.7: einzelne Mikros wurden viel zu stark verstärkt.
- Ursache 1 (Fehler): Nachkalibrieren der Summe über die Raum-Mikros lief mit bis zu 0,15 dB/s (9 dB/min) ohne Grenze → Fader kroch während langer Reden hoch. Jetzt 0,02 dB/s und höchstens ±3 dB um `base`.
- Ursache 2: Hörten die Raum-Mikros ein Mikro kaum, zog das Einmessen bis zur Obergrenze. Jetzt Wirkungskontrolle: nach +4 dB muss der Raum ≥ 1,5 dB lauter sein, sonst zurück auf den Ausgangspunkt, Einmessen ohne Raum (`noRoom`).
- Ursache 3: Leise/entfernte Sprecher wurden voll ausgeglichen. Jetzt höchstens +6 dB über der normalen Stellung; normaler Sprechpegel lernt nur aus Werten ±6 dB davon (5 % pro Schritt).
- Nachregeln läuft weiter, bis das 10-s-Fenster nur noch den neuen Pegel enthält (vorher Stopp auf halbem Weg).
- „Fader nie über“ ab Werk 0 dB (gespeicherte Werte bleiben). Verlauf nennt Gründe („spricht seit einiger Zeit leiser – gleiche +3 dB an“).
- Knopf „Hochpass 100 Hz für Sprecher-Mikros“ mit Rückfrage (im Simulator geprüft: HPF an, Index 32 = 100 Hz).

**1.9.0: Pfeifschutz über Dante**
- Samuel: Dante Virtual Soundcard ist auf dem Server-PC installiert, lizenziert, WDM. Er kennt sich mit Dante nicht aus und kann dort nichts ändern → alles automatisch.
- `dante-audio.ts`: sucht ffmpeg (web/tools/ffmpeg, PATH), listet DirectShow-Geräte, liest jedes „Dante/DVS“-Gerät mit allen Kanälen (f32le 48 kHz), Neustart alle 10 s bei Fehler. Kanal → Pult-Eingang per Pegel-Korrelation über 30 s.
- `spectrum.ts`: FFT 8192, Hop 4096. Pfeifen = Spitze ≥ 15 dB über Umgebung, ≥ −70 dBFS, ≥ 0,6 s stabil (±2 Bins), ≥ 80 % präsent, nicht abklingend, ≥ 2 dB gewachsen (Musik 4 dB), trägt ≥ ~25 % der Energie, keine Obertonreihe. Tests: Sprache (tiefe/hohe Stimme, je 60 s), Orgelakkord, Rauschen, Dauerton → kein Alarm; wachsender Ton → erkannt.
- `notch.ts`: freies Glocken-Band (0 dB, kein Shelf/LPF), am nächsten zur Frequenz; Q 8, −6 dB, vertiefen −3 dB bis −12 dB; Original wird gespeichert, „Kerben entfernen“ stellt es her. Im Simulator geprüft (2,5 kHz/Q 8/−12 dB gesetzt und exakt zurückgestellt).
- Opfer: das zuletzt besprochene offene Sprecher-Mikro (10 s), sonst das am weitesten aufgezogene. Pegel-basierter Pfeifschutz schweigt 3 s nach einem Dante-Ereignis.
- Server liest das EQ der Sprecher-Mikros alle ~10 s nach (`QLLink.setBackground`), damit „freies Band“ aktuell ist.
- Windows: `ensure-ffmpeg.ps1` (install + update) lädt BtbN-ffmpeg nach web\tools\ffmpeg; Fehlschlag bricht nicht ab.
- **Ungeprüft (kein Dante am Mac):** Gerätename der DVS unter DirectShow, Kanalzahl im WDM-Modus, ob der Dienst als SYSTEM die Soundkarte lesen darf (Windows-Mikrofon-Datenschutz). Die Anzeige „6 Dante-Ton“ zeigt den Fehlertext von ffmpeg.

**Sonstiges**
- 15 Web-Tests grün, `svelte-check` 0 Fehler.

## In Arbeit

- 1.9.1 (veröffentlicht): Ergebnis vom Windows-PC (Screenshot 2026-11-15): Dante-Lesen klappt – die DVS erscheint als 8 Stereo-Geräte „DVS Receive 1-2 … 15-16“ (16 Kanäle), 4 Kanäle mit Ton, zugeordnet zu ST IN 7 „Sampler“. Fix: Anzeige „DVS 5“ statt „Kanal 1“, stille Kanäle zusammengefasst; Zuordnung prüft jetzt auch MIX/MTX (ein Mix gewinnt, wenn er so gut passt wie seine einzelne Quelle).
- 1.9.2 (veröffentlicht): Screenshot nach 1.9.1: DVS 5–8 gleichmäßig um −47 dB, keine Zuordnung – und **Fehlalarm**: Kerbe 234 Hz −12 dB auf „Links“ (Samuel soll „Kerben entfernen“ drücken). Ursache: „gewachsen“ wurde als (letzter − kleinster Wert) ≥ 2 dB gemessen, Schwankung reichte. Fix: Anstieg = Mittel der letzten 3 − Mittel der ersten 3 Messungen ≥ 3 dB (Musik 5 dB), Töne ohne Anstieg nach 2,5 s gelten als stehend und werden ignoriert; Dante-Pfeifen wirkt nur noch auf Kanälen, die sicher einen Mix/Raum-/Sprecher-Mikro tragen (`classifyMatch`: alle gleich gut passenden Quellen müssen relevant sein). Versionsnummer in den Einstellungen.
- 1.9.3 (veröffentlicht): Samuel: „erkennt Musik, obwohl keine gespielt oder gesungen wird“. Ursachen: Union über alle Kanäle (irgendein Kanal aktiv in 40 % von 3 s), Übersprechen (Bühnenmikros hören den Prediger über PA), Gespräche/Geräusche. Fix: pro Kanal ≥ 50 % von 5 s aktiv, Kontinuität ≥ 75 % der Frames innerhalb 10 dB vom lauten Pegel (Sprache hat Lücken), kein Musik-Kanal, wenn er mit dem sprechenden Mikro korreliert (≥ 0,5). Tests für Übersprechen/Gespräche schlagen mit altem Code fehl, mit neuem nicht.
- 1.10.0 (veröffentlicht): Dante-Steuerung (ARC/UDP 4440, Format aus netaudio-core). Vom Mac aus **nur lesend** am echten Netz geprüft (2026-11-15): mDNS findet nur „PC-Vorne“ (192.168.1.246 = QLMix-Server mit DVS); dessen Belegung: DVS 1–2 ← Samplitude @ Aufnahme-PC (nicht erreichbar), **DVS 5–6 ← „Stream L/R“ @ Y001-Yamaha-QL5-1a5fa6 (verbunden)**, DVS 7–8 ← „Stream russisch“ @ MRX7-D, DVS 9–10 ← ST @ NY64-D (TF5, nicht erreichbar), 3–4 und 11–16 frei. QL5 und Rio antworten vom Mac aus nicht auf mDNS (eigenes Dante-Netz/VLAN?).
  - Server liest alle 30 s die eigene DVS-Belegung; Kanäle mit Quelle vom Pult (QL/CL) gelten als relevant → Dante-Pfeifschutz greift auf dem Stream-Mix ohne Umverkabelung.
  - Knopf „Raum-Mikro automatisch zuweisen“ (`dante-router.ts`): liest Pult-Dante-Eingänge, abonniert bis zu 4 freie DVS-Kanäle (von oben), prüft per Korrelation mit dem Raum-Mikro-Meter (≥ 0,8), entfernt Fehlversuche; merkt sich eigene Zuweisungen (`danteRoutes`), entfernt nur diese. Am echten Netz **nicht** schreibend getestet; braucht, dass der Server das Pult per mDNS findet.
  - Test-Hooks: `QLMIX_DANTE_DEVICE=host[:port]`, `QLMIX_AUDIO_INPUT`.
- Offen: Was liegt auf DVS 5–8? → geklärt (Stream-Mixe von QL5 und MRX7-D). Wenn ein Mix (Livestream/Aufnahme) mit den Sprecher-Mikros → Pfeifschutz über Dante wirkt. Wenn nur der Sampler → wirkungslos; dann bräuchte es einen Raum-Mikro- oder Mix-Kanal auf einem freien DVS-Empfangskanal (Dante-Routing, nur mit Samuels OK).
- Die Raum-Automatik ist in der **Testphase** (Badge „Test“ im UI). Der Nutzer testet sie im echten Raum.

## Nächste Schritte

- **Custom Fader Bank fertig bauen.** Samuel drückt am echten Pult „Fader-Ebenen vom Pult lesen“ und schickt das Ergebnis plus Foto der Custom-Ebene. Daraus den Aufbau ableiten, dann eigene Ebenen in der Bank-Leiste anzeigen und bei Änderungen am Pult nachladen.
  - Offene Frage an Samuel: Meint er die Custom Fader Bank (pro Benutzer), oder eine Reihenfolge pro Szene? Er hat es noch nicht beantwortet.
- **Samuel fragen, welche Funktionen ihm am meisten fehlen.** Vorschläge waren Mute-Gruppen, Pan, Sends eines Kanals auf alle Mixe, Szenen speichern. Er hat noch nicht geantwortet.

- 1.2.0 auf dem Windows-PC einspielen (`update.cmd`) und am echten Pult und iPhone prüfen. Die Rückmeldung des Nutzers steht noch aus.
- **Raum-Automatik (1.8) im echten Raum testen.**
  - Musik-Erkennung: Welche Kanäle zählen fälschlich als Musik (z. B. ein nicht ausgewähltes Sprechermikro)? → unter „Musik-Erkennung“ ausnehmen.
  - Öffnet es zu spät/zu früh? Empfindlichkeit anpassen; Schwellen in `autolevel.ts` (`OPEN_BELOW_SPEECH`, `CONFIRM_MS`).
- Falls die DVS keinen Ton empfängt: automatische Dante-Zuweisung eines freien DVS-Empfangskanals (Dante-Steuerprotokoll) prüfen – nur nach Rückfrage, da Dante-Routing.
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
