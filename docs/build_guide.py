#!/usr/bin/env python3
"""Erzeugt docs/QLMix-Anleitung.pdf (benötigt: reportlab, pillow).

    python3 -m pip install reportlab pillow
    python3 docs/build_guide.py
"""
import os
import re
from datetime import date

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image as RLImage, KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph,
    SimpleDocTemplate, Spacer, Table, TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img")
OUT = os.path.join(HERE, "QLMix-Anleitung.pdf")

# ---------------------------------------------------------------- Fonts
FONTS = "/System/Library/Fonts/Supplemental"
pdfmetrics.registerFont(TTFont("Body", f"{FONTS}/Arial.ttf"))
pdfmetrics.registerFont(TTFont("Body-Bold", f"{FONTS}/Arial Bold.ttf"))
pdfmetrics.registerFont(TTFont("Body-Italic", f"{FONTS}/Arial Italic.ttf"))
pdfmetrics.registerFont(TTFont("Uni", f"{FONTS}/Arial Unicode.ttf"))
pdfmetrics.registerFont(TTFont("Mono", "/System/Library/Fonts/Supplemental/Courier New.ttf"))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic", boldItalic="Body-Bold")

ACCENT = colors.HexColor("#1F6FB2")
DARK = colors.HexColor("#1B1F24")
MUTED = colors.HexColor("#5A6270")
LIGHT = colors.HexColor("#EEF3F8")
WARN_BG = colors.HexColor("#FFF6E0")
WARN = colors.HexColor("#B7791F")

base = ParagraphStyle("base", fontName="Body", fontSize=10.2, leading=14.6, textColor=DARK, spaceAfter=5)
S = {
    "body": base,
    "small": ParagraphStyle("small", parent=base, fontSize=8.6, leading=11.5, textColor=MUTED),
    "caption": ParagraphStyle("caption", parent=base, fontSize=8.6, leading=11, textColor=MUTED,
                              alignment=TA_CENTER, spaceBefore=3, spaceAfter=10),
    "h1": ParagraphStyle("h1", parent=base, fontName="Body-Bold", fontSize=17, leading=21,
                         textColor=ACCENT, spaceBefore=4, spaceAfter=8),
    "h2": ParagraphStyle("h2", parent=base, fontName="Body-Bold", fontSize=12.2, leading=16,
                         spaceBefore=9, spaceAfter=4),
    "title": ParagraphStyle("title", parent=base, fontName="Body-Bold", fontSize=30, leading=36,
                            textColor=DARK, spaceAfter=6),
    "subtitle": ParagraphStyle("subtitle", parent=base, fontSize=14, leading=19, textColor=MUTED, spaceAfter=18),
    "cell": ParagraphStyle("cell", parent=base, fontSize=9.2, leading=12.4, spaceAfter=0),
    "cellb": ParagraphStyle("cellb", parent=base, fontName="Body-Bold", fontSize=9.2, leading=12.4, spaceAfter=0),
    "toc": ParagraphStyle("toc", parent=base, fontSize=11, leading=17, spaceAfter=0),
}

SYMBOLS = "⌘⌥⇧"


def fmt(text: str) -> str:
    """Markup helper: `code` → Mono, symbols → Unicode font."""
    text = re.sub(r"`([^`]+)`", r'<font name="Mono" color="#24292F">\1</font>', text)
    return re.sub(f"([{SYMBOLS}])", r'<font name="Uni">\1</font>', text)


def P(text, style="body"):
    return Paragraph(fmt(text), S[style])


def bullets(items, style="body"):
    return ListFlowable(
        [ListItem(P(i, style), leftIndent=12, value="•") for i in items],
        bulletType="bullet", start="•", leftIndent=12, bulletFontName="Body", bulletFontSize=9,
    )


def steps(items):
    return ListFlowable(
        [ListItem(P(i), leftIndent=16) for i in items],
        bulletType="1", leftIndent=16, bulletFontName="Body-Bold", bulletFontSize=10, bulletColor=ACCENT,
    )


FRAME_W = A4[0] - 2 * 18 * mm


def image(name, width=FRAME_W, caption=None):
    path = os.path.join(IMG, name)
    w, h = Image.open(path).size
    width = min(width, FRAME_W)
    img = RLImage(path, width=width, height=width * h / w)
    parts = [img]
    if caption:
        parts.append(P(caption, "caption"))
    return KeepTogether(parts)


def table(rows, widths, header=True):
    data = [[P(c, "cellb" if (header and r == 0) or (j == 0 and not header) else "cell") for j, c in enumerate(row)]
            for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D0D7DE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), LIGHT))
    t.setStyle(TableStyle(style))
    return t


def box(text, kind="info"):
    bg, border = (LIGHT, ACCENT) if kind == "info" else (WARN_BG, WARN)
    label = "Hinweis" if kind == "info" else "Wichtig"
    t = Table([[P(f"<b>{label}:</b> {text}", "body")]], colWidths=[FRAME_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 7)])


# ---------------------------------------------------------------- Annotated screenshot
CALLOUTS = [  # (Nummer, x, y) in 1000er-Koordinaten des Fensterbilds
    # Obere Leiste: Markierung in der (leeren) Titelleiste direkt über dem Element
    (1, 62, 12), (2, 250, 12), (3, 327, 12), (4, 390, 12), (5, 845, 12), (6, 970, 12),
    (7, 512, 57), (8, 792, 57), (9, 33, 480), (10, 909, 440),
]


def annotate():
    im = Image.open(os.path.join(IMG, "mixer.png")).convert("RGB")
    f = im.size[0] / 1000
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype(f"{FONTS}/Arial Bold.ttf", int(15 * f))
    r = 11 * f
    for n, x, y in CALLOUTS:
        cx, cy = x * f, y * f
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(225, 45, 60), outline=(255, 255, 255), width=int(1.5 * f))
        draw.text((cx, cy + 0.5 * f), str(n), fill="white", font=font, anchor="mm")
    out = os.path.join(IMG, "mixer_annotated.png")
    im.save(out)
    return "mixer_annotated.png"


# ---------------------------------------------------------------- Page decoration
def on_page(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setFont("Body", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, 10 * mm, "QLMix – Bedienungsanleitung")
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Seite {doc.page}")
        canvas.setStrokeColor(colors.HexColor("#D0D7DE"))
        canvas.setLineWidth(0.4)
        canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
    canvas.restoreState()


# ---------------------------------------------------------------- Content
def build():
    annotated = annotate()
    s = []

    # Titelseite
    s += [
        Spacer(1, 28 * mm),
        P("QLMix", "title"),
        P("Bedienungsanleitung – Fernsteuerung für Yamaha QL1 / QL5 (und CL-Serie) auf dem Mac", "subtitle"),
        image("mixer.png"),
        Spacer(1, 10 * mm),
        P(f"Stand: {date.today().strftime('%d.%m.%Y')} · App-Version 1.0 · macOS 15 oder neuer", "small"),
        PageBreak(),
    ]

    # Inhalt
    toc = [
        "1  Überblick",
        "2  App installieren und starten",
        "3  Mit dem Mischpult verbinden",
        "4  Das Hauptfenster",
        "5  Der Kanalzug",
        "6  Monitormixe (Sends on Fader)",
        "7  EQ und Hochpassfilter",
        "8  Kanalname und Farbe",
        "9  Szenen aufrufen",
        "10  Einstellungen",
        "11  Protokoll-Log und Parameterliste",
        "12  Tastenkürzel",
        "13  Fehlerbehebung",
        "14  Grenzen und Sicherheitshinweise",
    ]
    s += [P("Inhalt", "h1")] + [P(t, "toc") for t in toc] + [PageBreak()]

    # 1 Überblick
    s += [
        P("1  Überblick", "h1"),
        P("QLMix steuert ein Yamaha-Digitalmischpult der QL-Serie (QL1, QL5) bzw. CL-Serie (CL1, CL3, CL5) "
          "vom Mac aus – ähnlich wie die iPad-App StageMix. Die App verbindet sich über das Netzwerk mit dem Pult "
          "und zeigt alle Änderungen in beide Richtungen live an: Bewegst du am Pult einen Fader, bewegt er sich auch in "
          "QLMix, und umgekehrt."),
        P("Was du mit QLMix machen kannst", "h2"),
        bullets([
            "Fader, <b>ON</b>-Tasten (Stummschaltung) und <b>CUE</b> aller Eingänge, Stereo-Eingänge, Mix- und Matrix-Busse, "
            "DCAs sowie Stereo- und Mono-Summe bedienen",
            "<b>Monitormixe</b> einstellen: Die Eingangsfader steuern dann die Sends auf einen Mix-Bus (Sends on Fader)",
            "<b>EQ</b> (4 Bänder) und <b>Hochpassfilter</b> pro Kanal mit grafischer Kurve bearbeiten",
            "Kanalnamen und -farben ändern",
            "Szenen aufrufen",
            "Pegelanzeigen (Meter) der Mix- und Matrix-Busse",
        ]),
        P("Was du brauchst", "h2"),
        bullets([
            "Einen Mac mit macOS 15 (Sequoia) oder neuer",
            "Eine Netzwerkverbindung zum Pult: per LAN-Kabel (direkt oder über Switch/Router) oder per WLAN über einen "
            "Router, der am Pult angeschlossen ist",
            "Ein Yamaha QL- oder CL-Pult mit aktueller Firmware",
        ]),
        box("QLMix nutzt die offizielle Fernsteuer-Schnittstelle der Yamaha-Pulte (TCP-Port 49280). Am Pult muss dafür "
            "nichts installiert oder freigeschaltet werden – es genügt, dass Mac und Pult im selben Netzwerk sind."),
    ]

    # 2 Installation
    s += [
        P("2  App installieren und starten", "h1"),
        steps([
            "Kopiere <b>QLMix.app</b> (im Projektordner unter `build/QLMix.app`) in deinen Ordner <b>Programme</b>.",
            "Starte QLMix per Doppelklick.",
            "Kommt beim Start die Meldung, dass der Entwickler nicht verifiziert werden kann (passiert nur, wenn die App "
            "auf einen anderen Mac kopiert wurde): Rechtsklick auf QLMix → <b>Öffnen</b> → <b>Öffnen</b>. Alternativ unter "
            "<b>Systemeinstellungen → Datenschutz &amp; Sicherheit</b> auf <b>Dennoch öffnen</b> klicken.",
            "Beim ersten Verbinden fragt macOS: <i>„QLMix möchte Geräte in deinem lokalen Netzwerk finden und sich mit "
            "ihnen verbinden.“</i> Klicke auf <b>Erlauben</b>. Ohne diese Erlaubnis kann die App das Pult nicht erreichen.",
        ]),
        box("Hast du die Netzwerk-Erlaubnis versehentlich abgelehnt, schalte sie unter <b>Systemeinstellungen → "
            "Datenschutz &amp; Sicherheit → Lokales Netzwerk</b> für QLMix ein.", "warn"),
        P("Neue Version bauen", "h2"),
        P("Wenn du den Quellcode geändert hast, erzeugst du die App im Terminal im Projektordner mit:"),
        P("`./scripts/make-app.sh`"),
    ]

    # 3 Verbinden
    s += [
        PageBreak(),
        P("3  Mit dem Mischpult verbinden", "h1"),
        P("Die Verbindung braucht drei Dinge: ein Kabel zur richtigen Buchse, passende IP-Adressen auf Pult und Mac, "
          "und die IP-Adresse des Pults in QLMix."),
        P("Schritt 1 – Kabel anschließen", "h2"),
        P("Verbinde die Buchse <b>NETWORK</b> auf der Rückseite des Pults mit deinem Mac. Das geht entweder direkt mit "
          "einem normalen LAN-Kabel (am Mac ggf. über einen USB-C-auf-Ethernet-Adapter) oder über einen Switch bzw. "
          "WLAN-Router, mit dem auch der Mac verbunden ist."),
        box("Nicht die <b>Dante</b>-Buchsen (PRIMARY / SECONDARY) verwenden – die sind nur für Audio. Für die "
            "Fernsteuerung ist ausschließlich die Buchse <b>NETWORK</b> zuständig.", "warn"),
        P("Schritt 2 – IP-Adresse des Pults ablesen", "h2"),
        steps([
            "Tippe am Pult-Display auf <b>SETUP</b>.",
            "Tippe unten auf <b>NETWORK</b>. Im Fenster siehst du <b>IP ADDRESS</b> und <b>SUBNET MASK</b>.",
            "Notiere die IP-Adresse. Werksseitig ist sie meist `192.168.0.128` mit Subnetzmaske `255.255.255.0`.",
        ]),
        P("Willst du die Adresse ändern: Werte mit dem [TOUCH AND TURN]-Regler einstellen, <b>OK</b> drücken und das Pult "
          "<b>neu starten</b>. Dafür sind Administratorrechte am Pult nötig.", "small"),
        P("Schritt 3 – IP-Adresse des Macs passend einstellen", "h2"),
        P("Mac und Pult müssen im <b>selben Subnetz</b> sein. Bei Subnetzmaske `255.255.255.0` heißt das: Die ersten drei "
          "Zahlenblöcke der IP-Adresse müssen gleich sein, der letzte muss sich unterscheiden."),
        table([
            ["Situation", "Was tun?"],
            ["Router mit DHCP im Netz (Pult und Mac am selben Router)",
             "Mac auf <b>DHCP</b> lassen. Prüfen, ob die Mac-Adresse im selben Bereich wie das Pult liegt "
             "(z. B. Pult `192.168.0.128`, Mac `192.168.0.25`). Wenn nicht: Pult-IP an den Router-Bereich anpassen "
             "oder Mac manuell einstellen."],
            ["Kabel direkt vom Mac zum Pult (kein Router)",
             "Am Mac eine feste Adresse einstellen, z. B. `192.168.0.10`, Subnetzmaske `255.255.255.0`."],
        ], [62 * mm, FRAME_W - 62 * mm]),
        Spacer(1, 6),
        P("<b>Feste IP-Adresse am Mac einstellen:</b>"),
        steps([
            "<b>Systemeinstellungen → Netzwerk</b> öffnen und den Ethernet-Anschluss wählen, an dem das Pult hängt "
            "(z. B. „USB 10/100/1000 LAN“).",
            "<b>Details …</b> → <b>TCP/IP</b>.",
            "<b>IPv4 konfigurieren:</b> „Manuell“. <b>IP-Adresse:</b> `192.168.0.10`, <b>Teilnetzmaske:</b> `255.255.255.0`. "
            "Router-Feld leer lassen.",
            "<b>OK</b> klicken.",
        ]),
        KeepTogether([
            P("Schritt 4 – In QLMix verbinden", "h2"),
            image("disconnected.png", caption="Vor dem Verbinden: IP-Adresse oben links eintragen, dann „Verbinden“."),
        ]),
        steps([
            "Trage die IP-Adresse des Pults oben links in das Feld <b>IP-Adresse</b> ein.",
            "Klicke auf <b>Verbinden</b> (oder drücke ⌘K).",
            "Der Punkt links oben wird <b>grün</b> und zeigt „Verbunden“. Daneben erscheinen Modell und Firmware des Pults "
            "(z. B. „QL5 · V5.81“). QLMix lädt jetzt alle Fader, Namen und Farben vom Pult – das dauert etwa eine Sekunde.",
        ]),
        table([
            ["Punkt", "Bedeutung"],
            ["grau", "Getrennt – keine Verbindung gewünscht."],
            ["orange", "Verbinde … bzw. Verbindung verloren – QLMix versucht es automatisch erneut "
                       "(nach 1, 2, 4, 8 … Sekunden, höchstens alle 10 Sekunden)."],
            ["grün", "Verbunden. Alle Bedienelemente sind aktiv."],
            ["rot", "Verbindung fehlgeschlagen. Der Grund steht daneben (siehe Kapitel 13)."],
        ], [24 * mm, FRAME_W - 24 * mm]),
        Spacer(1, 6),
        box("Unter <b>QLMix → Einstellungen</b> (⌘,) kannst du „Beim Start automatisch verbinden“ einschalten. Dann "
            "verbindet sich QLMix bei jedem Start sofort mit der zuletzt verwendeten Adresse."),
        box("Reißt die Verbindung ab (Kabel gezogen, Pult neu gestartet), verbindet sich QLMix automatisch neu und lädt "
            "danach den aktuellen Stand vom Pult. Du musst nichts tun."),
    ]

    # 4 Hauptfenster
    s += [
        PageBreak(),
        P("4  Das Hauptfenster", "h1"),
        image(annotated, caption="Das Hauptfenster mit Eingangskanälen 1–16."),
        table([
            ["Nr.", "Element", "Funktion"],
            ["1", "Verbindungsstatus", "Farbiger Punkt und Text (siehe Kapitel 3)."],
            ["2", "IP-Adresse", "Adresse des Pults. Nur änderbar, solange keine Verbindung besteht."],
            ["3", "Verbinden / Trennen", "Baut die Verbindung auf bzw. ab (⌘K / ⇧⌘K)."],
            ["4", "Pult-Info", "Erkanntes Modell und Firmware. QLMix passt die Kanalzahl automatisch an (QL1: 32, QL5: 64 Eingänge)."],
            ["5", "Szene", "Aktuelle Szenennummer, Eingabefeld und <b>Recall</b> (Kapitel 9)."],
            ["6", "Log", "Öffnet das Protokoll-Fenster (Kapitel 11)."],
            ["7", "Ebenen", "Welche Kanäle angezeigt werden: CH 1–16, 17–32 …, ST IN, MIX, MATRIX, DCA (⌘1 … ⌘9)."],
            ["8", "Fader-Modus", "„Main“ = normale Kanalfader, „Sends → MIX n“ = Monitormix (Kapitel 6)."],
            ["9", "Kanalzüge", "Ein Zug pro Kanal (Kapitel 5). Bei vielen Kanälen horizontal scrollen."],
            ["10", "Summen", "Stereo- (ST) und Mono-Summe – immer sichtbar, im Monitormix-Modus zusätzlich der Mix-Master."],
        ], [11 * mm, 36 * mm, FRAME_W - 47 * mm]),
    ]

    # 5 Kanalzug
    s += [
        PageBreak(),
        P("5  Der Kanalzug", "h1"),
        P("Jeder Kanalzug ist von oben nach unten so aufgebaut:"),
        table([
            ["Element", "Bedienung"],
            ["Kanalnummer", "z. B. „CH 13“."],
            ["CUE", "Vorhören. Leuchtet <b>gelb</b>, wenn aktiv; der ganze Kanalzug bekommt dann einen gelben Rahmen."],
            ["ON", "Kanal ein/aus. <b>Grün</b> = Kanal an, <b>grau</b> = stumm (wie die ON-Taste am Pult)."],
            ["EQ-Kurve", "Mini-Vorschau des Kanal-EQs. Ein Klick öffnet den EQ-Editor (Kapitel 7)."],
            ["dB-Anzeige", "Aktueller Faderwert, z. B. „-6.0“, „+2.5“ oder „-∞“."],
            ["Fader", "Siehe unten."],
            ["Meter", "Grüne Pegelanzeige neben dem Fader – nur bei Mix- und Matrix-Bussen (siehe Kapitel 14)."],
            ["Namensfeld", "Kanalname in der Kanalfarbe. Klick öffnet den Namens-Editor (Kapitel 8)."],
        ], [32 * mm, FRAME_W - 32 * mm]),
        P("Fader bedienen", "h2"),
        bullets([
            "<b>Ziehen:</b> Klicke irgendwo auf die Faderbahn und ziehe nach oben oder unten. Der Fader bewegt sich "
            "<b>relativ</b> – ein Klick lässt ihn nie springen. So kann im Live-Betrieb nichts versehentlich laut werden.",
            "<b>Feinregelung:</b> Halte beim Ziehen die Wahltaste ⌥ gedrückt.",
            "<b>Scrollrad / Trackpad:</b> ±0,5 dB pro Schritt, mit ⌥ ±0,1 dB.",
            "<b>Rechtsklick</b> auf den Fader: „Auf 0 dB setzen“, „Auf −∞ setzen“ oder „−10 dB“.",
        ]),
        P("Die Skala entspricht dem Pult: 0 dB liegt bei etwa drei Viertel des Weges, ganz oben sind +10 dB."),
        box("Während du einen Fader ziehst, ignoriert QLMix Rückmeldungen des Pults für genau diesen Fader – so "
            "„springt“ er nicht. Bewegt jemand am Pult denselben Fader gleichzeitig, gewinnt die letzte Bewegung."),
    ]

    # 6 Sends
    s += [
        P("6  Monitormixe (Sends on Fader)", "h1"),
        P("Damit stellst du z. B. den In-Ear- oder Wedge-Mix eines Musikers ein – die wichtigste Funktion von StageMix."),
        steps([
            "Klicke rechts oben auf das Menü <b>Fader:</b>.",
            "Wähle den Mix, z. B. <b>Sends → MIX 1 Mon 1</b>. Hinter der Nummer steht der Name des Mix-Busses.",
            "Die Eingangskanäle werden <b>orange</b>. Ihre Fader und ON-Tasten steuern jetzt den <b>Send</b> zu diesem Mix, "
            "nicht mehr die Hauptlautstärke.",
            "Rechts erscheint zusätzlich der <b>Master des Mixes</b> (z. B. „MIX 1“) mit Meter.",
            "Zurück zur normalen Ansicht: <b>Fader: Main (Kanal-Fader)</b> wählen oder ⌥⌘0 drücken.",
        ]),
        image("sends_menu.png", width=95 * mm, caption="Auswahl des Monitormixes."),
        image("sends.png", caption="Sends on Fader: Die orangen Fader steuern die Sends zu MIX 1 „Mon 1“. "
                                   "Bei CH 11 ist der Send ausgeschaltet (ON grau)."),
    ]

    # 7 EQ
    s += [
        PageBreak(),
        P("7  EQ und Hochpassfilter", "h1"),
        P("Klicke im Kanalzug auf die kleine <b>EQ-Kurve</b> (oder drücke ⌘E). Rechts öffnet sich der EQ-Editor für "
          "diesen Kanal. Ein erneuter Klick auf die Kurve oder das <b>×</b> schließt ihn wieder."),
        image("eq_panel.png", width=125 * mm, caption="EQ-Editor für CH 13 „Vox 1“."),
        P("Bedienung", "h2"),
        table([
            ["Was", "Wie"],
            ["Band verschieben", "Nummerierten Punkt (1–4) in der Kurve ziehen: links/rechts = Frequenz, hoch/runter = Gain."],
            ["Güte (Q) ändern", "Band anklicken, dann mit Scrollrad/Trackpad über der Kurve scrollen (⌥ = fein)."],
            ["Band auf 0 dB", "Doppelklick auf den Punkt."],
            ["Genaue Werte", "Schieberegler Freq / Gain / Q in den vier Feldern unter der Kurve."],
            ["Bell / Shelf", "Bei LOW und HIGH: Knopf „Bell“ bzw. „Shelf“ schaltet zwischen Glocke und Kuhschwanz um."],
            ["Hochpassfilter", "<b>HPF</b>-Taste ein/aus, Frequenz mit dem Regler daneben oder Punkt „H“ in der Kurve ziehen."],
            ["EQ ein/aus", "<b>EQ ON</b> – bei „aus“ wird die Kurve grau dargestellt."],
            ["Alles neutral", "<b>Flat</b> setzt alle vier Bänder auf 0 dB (HPF bleibt unverändert)."],
            ["Kanal wechseln", "Pfeile ‹ › neben dem Kanalnamen oder auf die EQ-Kurve eines anderen Kanals klicken."],
        ], [34 * mm, FRAME_W - 34 * mm]),
        P("Wertebereiche: Frequenz 20 Hz – 20 kHz, Gain ±18 dB, Q 0,1 – 16, Hochpass 20 – 600 Hz.", "small"),
        box("Yamaha dokumentiert die EQ-Befehle für die QL/CL-Pulte nicht offiziell. QLMix prüft deshalb beim Verbinden, "
            "ob dein Pult EQ-Befehle annimmt. Erscheint im EQ-Editor <b>„Pult beantwortet keine EQ-Befehle“</b>, klicke dort "
            "auf <b>„Parameterliste auslesen“</b> und schick die Datei aus <b>Dokumente → QLMix</b> an den Entwickler. Damit "
            "lässt sich der EQ für dein Pult anpassen. Alle anderen Funktionen sind davon nicht betroffen.", "warn"),
    ]

    # 8 Name & Farbe
    s += [
        P("8  Kanalname und Farbe", "h1"),
        image("label_editor.png", width=62 * mm, caption="Namens-Editor."),
        steps([
            "Klicke unten im Kanalzug auf das farbige <b>Namensfeld</b>.",
            "Tippe den neuen Namen ein (höchstens 8 Zeichen, wie am Pult).",
            "Klicke auf eine Farbe – sie wird sofort übernommen.",
            "<b>Übernehmen</b> (oder Eingabetaste) speichert den Namen am Pult.",
        ]),
    ]

    # 9 Szenen
    s += [
        P("9  Szenen aufrufen", "h1"),
        steps([
            "Rechts oben neben „Szene“ siehst du die aktuelle Szenennummer (z. B. <b>012</b>).",
            "Gib die gewünschte Nummer in das Feld <b>Nr.</b> ein und klicke <b>Recall</b> (oder drücke die Eingabetaste).",
            "Bestätige die Sicherheitsabfrage. Das Pult lädt die Szene, QLMix übernimmt danach automatisch alle neuen Werte.",
        ]),
        box("Ein Szenen-Recall überschreibt den aktuellen Mix am Pult. Die Sicherheitsabfrage kannst du in den "
            "Einstellungen abschalten – im Live-Betrieb empfehlen wir, sie eingeschaltet zu lassen.", "warn"),
        P("Wird am Pult selbst eine Szene aufgerufen, zeigt QLMix die neue Nummer an und lädt alle Werte neu."),
    ]

    # 10 Einstellungen
    s += [
        PageBreak(),
        P("10  Einstellungen", "h1"),
        P("Menü <b>QLMix → Einstellungen …</b> (⌘,)."),
        image("settings.png", width=95 * mm, caption="Einstellungen."),
        table([
            ["Einstellung", "Bedeutung"],
            ["IP-Adresse / TCP-Port", "Adresse des Pults. Der Port ist bei QL/CL immer `49280` – nur ändern, wenn du weißt warum."],
            ["Beim Start automatisch verbinden", "Verbindet beim Öffnen der App sofort mit der gespeicherten Adresse."],
            ["Fader-Sendeintervall", "Wie oft Faderbewegungen ans Pult gesendet werden (Standard 30 ms). Kleiner = "
                                     "direkter, größer = weniger Netzwerklast (z. B. bei schwachem WLAN)."],
            ["Szenen-Recall bestätigen", "Sicherheitsabfrage vor jedem Szenenaufruf."],
            ["Meter anfordern", "Pegelanzeigen der Mix- und Matrix-Busse ein/aus."],
            ["Meter-Intervall", "Aktualisierungsrate der Meter (Standard 100 ms)."],
            ["Pult", "Zeigt Modell, Firmware und Kanalanzahl des verbundenen Pults."],
        ], [52 * mm, FRAME_W - 52 * mm]),
    ]

    # 11 Log
    s += [
        KeepTogether([
            P("11  Protokoll-Log und Parameterliste", "h1"),
            P("Das Log-Fenster (⌘L oder Knopf <b>Log</b>) zeigt jede Nachricht zwischen QLMix und Pult. Du brauchst es nur "
              "zur Fehlersuche."),
            image("log.png", caption="Protokoll-Log: → gesendet (orange), ← empfangen (grün), • Status."),
        ]),
        bullets([
            "<b>Filter:</b> zeigt nur Zeilen mit dem eingegebenen Text.",
            "<b>Kopieren:</b> kopiert die angezeigten Zeilen in die Zwischenablage – praktisch, um ein Problem zu melden.",
            "<b>Parameterliste auslesen:</b> fragt alle Parameter ab, die das Pult über die Schnittstelle anbietet, und speichert "
            "sie als Textdatei unter <b>Dokumente → QLMix</b>. „Im Finder zeigen“ öffnet den Ordner.",
            "<b>Befehlszeile</b> (unten): sendet beliebige Befehle direkt ans Pult. Unter „Beispiele“ findest du "
            "ungefährliche Abfragen. Nur für Fortgeschrittene!",
        ]),
    ]

    # 12 Tastenkürzel
    s += [
        PageBreak(),
        P("12  Tastenkürzel", "h1"),
        table([
            ["Kürzel", "Funktion"],
            ["⌘K", "Verbinden"],
            ["⇧⌘K", "Trennen"],
            ["⌘R", "Alles neu vom Pult laden"],
            ["⌘1 … ⌘9", "Ebene wählen (CH 1–16, CH 17–32, …, ST IN, MIX, MATRIX, DCA)"],
            ["⌥⌘0", "Fader-Modus zurück auf „Main“"],
            ["⌘E", "EQ-Editor öffnen / schließen"],
            ["⌘L", "Protokoll-Log öffnen"],
            ["⌘,", "Einstellungen"],
            ["⌥ + Ziehen", "Fader / Regler fein einstellen"],
            ["Scrollrad", "Fader ±0,5 dB (⌥: ±0,1 dB); im EQ: Q des gewählten Bands"],
        ], [36 * mm, FRAME_W - 36 * mm]),
    ]

    # 13 Fehlerbehebung
    s += [
        P("13  Fehlerbehebung", "h1"),
        table([
            ["Meldung / Problem", "Ursache und Lösung"],
            ["„Pult nicht erreichbar (Netzwerk/IP prüfen)“",
             "Mac und Pult sind nicht im selben Netz. Kabel an der Buchse <b>NETWORK</b>? IP-Adressen im selben Bereich "
             "(Kapitel 3)? WLAN am Mac aus, wenn du per Kabel verbunden bist und beide Netze denselben Adressbereich haben."],
            ["„Zeitüberschreitung beim Verbindungsaufbau“",
             "Falsche IP-Adresse oder Pult aus. IP am Pult unter SETUP → NETWORK prüfen."],
            ["„Verbindung abgelehnt (Port geschlossen?)“",
             "Unter der Adresse antwortet ein Gerät, aber kein Yamaha-Pult – oder der Port wurde in den Einstellungen geändert "
             "(muss `49280` sein)."],
            ["Verbindet nie, keine Fehlermeldung",
             "Netzwerk-Erlaubnis fehlt: Systemeinstellungen → Datenschutz &amp; Sicherheit → Lokales Netzwerk → QLMix einschalten."],
            ["„Keine Antwort vom Pult (Timeout)“",
             "Die Verbindung ist abgerissen (Kabel, WLAN, Pult neu gestartet). QLMix verbindet sich automatisch neu."],
            ["Werte stimmen nicht mit dem Pult überein", "⌘R („Neu synchronisieren“) lädt alle Werte neu vom Pult."],
            ["Keine Meter zu sehen",
             "Meter gibt es nur für Mix- und Matrix-Busse (Ebene MIX / MATRIX). In den Einstellungen „Meter anfordern“ prüfen."],
            ["EQ-Editor: „Pult beantwortet keine EQ-Befehle“", "Siehe Hinweis in Kapitel 7."],
        ], [52 * mm, FRAME_W - 52 * mm]),
        Spacer(1, 6),
        P("Verbindung im Terminal testen", "h2"),
        P("Ersetze die Adresse durch die deines Pults:"),
        P("`ping 192.168.0.128` – antwortet das Pult überhaupt? (Abbrechen mit ctrl-C)"),
        P("`nc -vz 192.168.0.128 49280` – ist die Fernsteuer-Schnittstelle erreichbar? Erwartet: „succeeded“."),
    ]

    # 14 Grenzen
    s += [
        PageBreak(),
        P("14  Grenzen und Sicherheitshinweise", "h1"),
        bullets([
            "<b>Vor dem ersten Live-Einsatz testen!</b> Probiere alle Funktionen, die du brauchst, in Ruhe am Pult aus.",
            "<b>Meter:</b> Die Schnittstelle der QL/CL-Pulte liefert nur Pegel der Mix- und Matrix-Busse. "
            "Eingangsmeter sind darüber nicht verfügbar.",
            "<b>EQ:</b> nur verfügbar, wenn das Pult die EQ-Befehle annimmt (siehe Kapitel 7).",
            "<b>Faderkurve:</b> Die Skala ist an Yamaha angelehnt, aber nicht exakt gleich. Die dB-Anzeige stimmt immer "
            "mit dem Pult überein.",
            "<b>Mehrere Bediener:</b> Änderungen am Pult, aus StageMix oder einer zweiten QLMix-Instanz werden live angezeigt. "
            "Sprecht euch ab, wer was bedient.",
            "<b>WLAN:</b> funktioniert, ist aber störanfälliger als ein Kabel. Für den Live-Betrieb ist ein LAN-Kabel "
            "oder ein eigener, ungestörter WLAN-Router empfehlenswert.",
        ]),
        Spacer(1, 10),
        P("Für Entwickler: Testen ohne Pult", "h2"),
        P("Im Projekt ist ein Pult-Simulator enthalten. Im Terminal im Projektordner starten:"),
        P("`swift run QLSimulator --animate`"),
        P("Dann in QLMix die Adresse `127.0.0.1` eintragen und verbinden. Mit `--no-eq` simuliert er ein Pult ohne "
          "EQ-Unterstützung, mit `--model QL1` ein QL1."),
    ]

    doc = SimpleDocTemplate(
        OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
        title="QLMix – Bedienungsanleitung", author="QLMix", subject="Fernsteuerung für Yamaha QL/CL",
    )
    doc.build(s, onFirstPage=on_page, onLaterPages=on_page)
    print(OUT)


if __name__ == "__main__":
    build()
