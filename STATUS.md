# STATUS – QLMix

Stand: 2026-11-09 · aktuelle Version **1.2.0** (Release `v1.2.0`, Commit `9fb59da`)

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

**Sonstiges**
- 15 Web-Tests grün, `svelte-check` 0 Fehler.

## In Arbeit

- Nichts offen im Code. Alle Änderungen sind committet und gepusht.
- Die Raum-Automatik ist in der **Testphase** (Badge „Test“ im UI). Der Nutzer testet sie im echten Raum.

## Nächste Schritte

- 1.2.0 auf dem Windows-PC einspielen (`update.cmd`) und am echten Pult und iPhone prüfen. Die Rückmeldung des Nutzers steht noch aus.
- **Raum-Automatik im echten Raum testen.**
  - Prüfen, ob die Kanzel jetzt erkannt wird.
  - Ziel-Lautstärke, Tempo und Grenzen praxisnah einstellen.
- **Dynamics abgleichen:**
  - Am Pult Regler drehen und die angezeigten Werte (dB, ms, Ratio) mit dem Pult vergleichen.
  - Danach in `ql-params.ts` `calibrated: true` setzen und die Umrechnung korrigieren.
  - Dafür muss der Mac im Pult-Netz sein.
- **Premium Rack abgleichen:**
  - Pro Modul (Portico 5033/5043, Dynamic EQ …) mit der Kalibrierhilfe ermitteln, welcher Parameter-Index welcher Regler ist.
  - Dann `RACK_MODULES` in `ql-params.ts` füllen; die Liste ist aktuell leer.
- Optional: PDF-Anleitung auf die Web-Version umstellen. Sie beschreibt noch die Mac-App.

## Bekannte Probleme / Offene Fragen

- **Nur eine Verbindung pro IP:**
  - Das Pult bedient pro Client-IP nur die neueste Verbindung.
  - Ein QL Editor auf demselben PC wie der QLMix-Server bricht deshalb die EQ-Verbindung (und umgekehrt).
  - Workaround: Editor schließen oder auf einem anderen Rechner nutzen.
- Das Pult pusht EQ-Änderungen nicht. Der Server fragt ab, daher erscheinen Änderungen am Pult mit kurzer Verzögerung.
- Die Dynamics-Anzeigen sind **ungefähr** (markiert mit „≈“). Die Regler funktionieren, die Einheiten können abweichen.
- Raum-Automatik:
  - Das Handy muss im Vordergrund bleiben und den Bildschirm anlassen.
  - Fürs Mikrofon ist auf dem iPhone das QLMix-Zertifikat nötig (einmalige Einrichtung, siehe README).
- `web/package-lock.json` führt noch Version `1.0.0` (nur kosmetisch). TODO: klären, ob mit `npm install` angleichen.
- TODO: klären, ob die Mac-App (`Sources/QLMix`) weiter gepflegt oder als Legacy markiert werden soll.
- TODO: klären, ob die alten Mac-Screenshots in `docs/img/*.png` noch gebraucht werden. Sie werden nur von der PDF-Anleitung und `build_guide.py` verwendet, das ist aber nicht geprüft.
- Die Konsole meldet bei RCP-EQ „Pult beantwortet keine EQ-Befehle über RCP“. Das ist bei CL/QL normal, der EQ läuft über SysEx.
