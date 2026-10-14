# Umsetzungsplan – v2.5: Eigene Käufe & Privat

(v2.3 Auto-Refresh/Theme/Übersicht und v2.4 Betriebskosten/Geschäftsjahr sind umgesetzt.)

## Entscheidungen (geklärt)
- **Eigene Käufe** von anderen Seiten (Kleinanzeigen, eBay, Flohmarkt …) kann man eintragen. Sie sind **standardmäßig geschäftlich** und zählen ganz normal mit (Ausgaben, Lager, Gewinn, Zuordnung zu Vinted-Verkäufen).
- Angaben: **Titel, Preis, Datum, Plattform, Foto (optional)**. Status wählbar, Standard **„Im Lager“**.
- **Haken „Privat“**: im Formular für eigene Käufe und in der Detailansicht **jedes** Kaufs (auch Vinted). Standard: aus.
- **Privat = nur zur Ansicht:** erscheint nur unter dem Filter-Chip **„Privat“** in „Käufe“, nicht unter „Alle“, nirgends in der Übersicht. Es fließt in keine Rechnung ein: kein Umsatz, keine Ausgaben, kein Gewinn, kein Lager, keine Betriebskosten, kein Export, kein Popup.
- Privat gilt **nur für Käufe**. Verkäufe zählen immer, außer sie sind einem privaten Kauf zugeordnet.

---

## Schritt 1 – Datenmodell (`shared.js`)
1. Neuer Speicher `manualOrders` (chrome.storage.local):
   `{ id: "m-…", title, amount, date, platform, platformOther, photo, createdAt }`.
   Status, Verkaufspreis/-datum, Zusatzkosten, Notiz und **privat** liegen wie bei Vinted-Käufen in `meta[id]`.
   Den automatischen Abgleich mit Vinted fassen eigene Käufe nicht an (eigener Speicher).
2. `manualToOrder()` wandelt eigene Käufe in das gleiche Format wie Vinted-Käufe (`source: "manual"`). Ohne gewählten Status gilt „Im Lager“ statt der Versandphase.
3. `resellerModel`: Jeder Kauf bekommt `private`. Private Käufe
   - erzeugen keine Kauf- und keine Verkaufs-Ereignisse → kein Umsatz, keine Ausgaben, kein Gewinn, keine Betriebskosten
   - zählen nicht zu Lager, Verkaufsquote, Zählern
   - werden **nicht automatisch** einem Vinted-Verkauf zugeordnet. Ordnest du einen Verkauf von Hand einem privaten Kauf zu, ist auch dieser Verkauf privat und zählt nicht.

## Schritt 2 – Käufe-Liste (`dashboard.html/.js/.css`)
- Kopf: **„+ Eigener Kauf“**-Button neben der Suche.
- Filterleiste: `Alle · Unterwegs · Im Lager · … · 🔒 Privat N`. „Alle“ und alle Status-Chips ohne Private; „Privat“ zeigt nur sie.
- Zeile eines eigenen Kaufs: Datum · **Plattform** (statt Vinted-Status). Foto oder Platzhalter mit Plattform-Kürzel (z. B. „KA“, „eBay“).
- Private Zeilen: ein Schloss und gedämpfte Darstellung, rechts nur der Preis.
- Navigations-Zähler „Käufe“ ohne Private.

## Schritt 3 – Formular „Eigener Kauf“ (Dialog)
```
Eigener Kauf
Titel*            [Levi's 501 W32                    ]
Preis (€)* [12,00]      Gekauft am* [11.10.2026]
Plattform  [Kleinanzeigen ▾]   (bei „Sonstige“: Freitext)
Status     [Im Lager ▾]  → bei „Verkauft“: Verkaufspreis + Verkaufsdatum
Zusatzkosten (€) [   ]   Notiz [                      ]
Foto       [Datei wählen]  ▢ Vorschau  [entfernen]
☐ Privat – wird nirgends mitgerechnet, nur unter „Privat“ sichtbar
                                   [Löschen] [Abbrechen] [Speichern]
```
- Foto: wird im Browser auf max. 600 px verkleinert (JPEG) und lokal gespeichert.
- Bearbeiten/Löschen: in der Detailansicht eines eigenen Kaufs über „Eintrag bearbeiten“.

## Schritt 4 – Detailansicht
- Bei jedem Kauf ein Haken **„Privat“**. Ist er gesetzt, steht oben ein Hinweis, Verkaufs-Zuordnung und Gewinnfelder sind ausgeblendet.
- Eigene Käufe: Plattform statt Vinted-Status, kein „Versand & Details von Vinted laden“, dafür der Button „Eintrag bearbeiten“.

## Schritt 5 – Überall herausfiltern
- Übersicht (Kacheln, Diagramm, Lager, Nächste Schritte, Bestenliste, Marken, Verteilung), Export, Popup: private Käufe ausgeschlossen.
- Export: eigene geschäftliche Käufe sind dabei. In der Spalte „Status laut Vinted“ steht die Plattform.

## Schritt 6 – Abschluss
- Logiktests: Private zählen nirgends, kein automatischer Abgleich mit Privaten, eigene Käufe zählen normal und werden automatisch einem Verkauf zugeordnet, Standardstatus „Im Lager“.
- Klicktest und Screenshots, Version 2.5.0, LIESMICH.
