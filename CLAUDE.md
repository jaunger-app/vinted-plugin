# Vinted-Plugin – Kontext für Claude

Chrome-Erweiterung (Manifest V3, Vanilla JS, kein Build-Schritt), Marke **refold**. **Seit 2.9.0 kein eigenes Dashboard
mehr:** Die Erweiterung ist die Brücke zwischen der Vinted-Sitzung im Browser und der Web-App (`../vinted-webapp`):
Zugangs-Token weitergeben, Sitzung im vinted.de-Tab erneuern, Antworten senden. Das Popup meldet mit dem refold-Konto der
Website an (Server-Endpunkte `/api/extension/*` der Web-App, siehe dort `claude-anleitung/046-extension-login.md`).
Version siehe `manifest.json` (aktuell 2.9.4; Senden der Web-App-Antworten über den Messaging-Dienst `api.vinted.de/messaging/main/conversations/<uuid>/replies`, siehe Versionen; „Mit Google anmelden“ = Übergabe von der Website-Seite `/erweiterung-verbinden` über die Brücke `ext-session` → `background.js webappSession`, die die Sitzung per `/api/extension/me` bestätigt). Der Abschnitt „Fachliche Regeln“ und `shared.js` beschreiben den alten
Dashboard-Stand (Logik lebt in der Web-App weiter, `shared.js` wird nicht mehr geladen, nur noch getestet).
Schwesterprojekt: `../vinted-webapp` (Next.js-Port desselben Dashboards, eigene `CLAUDE.md`).

## Zusammenarbeit mit dem Nutzer (wichtig)
- **Sprache: Deutsch** – Antworten, UI-Texte, Code-Kommentare.
- **Arbeitsweise, die der Nutzer ausdrücklich will:** (1) Auftrag durchgehen und offene Fragen *sofort*
  stellen (AskUserQuestion, Empfehlung als erste Option), (2) Schritt-für-Schritt-Plan als Datei
  (`UMSETZUNGSPLAN.md`) schreiben, (3) letzte Unklarheiten klären, (4) Schritt für Schritt umsetzen,
  (5) prüfen (Tests + Headless-Screenshots) und ehrlich berichten, was nicht testbar war.
- Nicht testbar ohne Nutzer: alles mit echtem Vinted-Login (Cookies). Immer so kennzeichnen.
- Keine Commits ungefragt (Ordner ist kein Git-Repo).

## Dateien
| Datei | Rolle |
| --- | --- |
| `manifest.json` | MV3, Name „refold“. Rechte: scripting, storage, unlimitedStorage (alter lokaler Datenbestand), cookies, declarativeNetRequestWithHostAccess (**„alarms“ seit 2.9.0 entfernt**); Host: `https://www.vinted.de/*` + Web-App `http://localhost:3000/*`, `https://jucreative.de/*` (für die Konto-Endpunkte ohne CORS) |
| `account.js` | (2.9.0) Konto der Erweiterung: `login`, `logout`, `idToken` (erneuert vor Ablauf), `authedRequest` (bei 401 einmal neu), `currentUser` (serverseitig geprüft), `requestPasswordReset`, Server-Auswahl `WEB_BASES`. Speicher: `extAuth` (Refresh-Token + Konto + Server) in `storage.local`, `extIdToken` in `storage.session`; nie Passwörter |
| `webapp-bridge.js` | Content-Script nur auf `http://localhost:3000/*`, `https://jucreative.de/*`, `https://www.jucreative.de/*` (Web-App `../vinted-webapp`): setzt `<html data-vinted-ext>`, beantwortet `postMessage` `request-token` (optional `fresh`) nur mit `access_token_web`, `status` (Version + angemeldet) und `token-match` (SHA-256-Vergleich), `send-reply` (2.8.8, Antwort im Postfach senden, siehe unten) (über `background.js` → `webappToken`, prüft Absender-Origin gegen `WEBAPP_ORIGINS`). Neue Web-App-Adresse ⇒ in Manifest **und** `WEBAPP_ORIGINS` eintragen. |
| `background.js` | Service Worker: Brücke zur Web-App (`webappToken/Status/TokenMatch/Send`), Sitzungserneuerung (auch im vinted.de-Tab), merkt `lastHandoffAt` (storage.session) fürs Popup. **Seit 2.9.0 kein eigener Abgleich mehr** (kein Alarm, keine Dashboard-Nachrichten); `runSync`/`autoSync` bleiben als Code (Tests) |
| `shared.js` | **Gesamte Rechenlogik** + Storage-Helfer, von Popup und Dashboard per `<script>` geladen (globale Funktionen). Kategorie/Marke (`categoryOf`, `categoryInfo`, `brandOf`, Wortliste `CATEGORY_WORDS`) erkennen **ganze Wörter** mit Punkten statt Wortstücken (seit 2026-10-14, gespiegelt aus der Web-App, siehe dort `claude-anleitung/023-…`); der zweite Parameter (Vinted-Kategoriepfad/-Marke) bleibt hier leer |
| `popup.html/.js/.css` | (2.9.0) refold-Popup, monochrom: A) Anmelden (E-Mail/Passwort, Passwort vergessen, Registrieren → Website), B) angemeldet: Konto + Abmelden, Vinted-Status im Browser, Konten aus der Web-App, „Jetzt aktualisieren“, „Dashboard öffnen“; Server-Auswahl im Fuß. Schriften Inter/Syne/DM Mono lokal in `fonts/` |
| ~~`dashboard.*`, `base.css`, `theme.css`, `theme-init.js`~~ | 2.9.0 entfernt (Dashboard lebt in der Web-App) |
| `tests/*.js` | Node-Tests (siehe unten); `test-account.js` (2.9.0) prüft account.js; E2E des Popups mit „Chrome for Testing“ (Playwright-Cache), da Marken-Chrome `--load-extension` ignoriert |
| `tools/build-store.mjs` | (2.9.2) Store-Paket `dist/refold-<version>-store.zip`: entfernt `http://localhost:3000` aus Manifest, `WEB_BASES` und `WEBAPP_ORIGINS`, nimmt nur geladene Dateien (kein `shared.js`, nur Schriften aus `popup.css`), bricht bei Rest-„localhost“ oder Syntaxfehler ab. Quellcode behält localhost (Entwicklung + Gleichheitstest der Web-App). Test `tests/test-store-build.js`. Store-Assets: `../marketing/refold-store` |
| `LIESMICH.txt` | Nutzer-Doku, pro Version ein Abschnitt „Neu in x.y“ oben |
| `UMSETZUNGSPLAN.md` | Plan der jeweils letzten größeren Änderung |

## Datenfluss
1. **Laden (background.js, ohne Fenster):** `vintedFetch(path)` → direkt `fetch` aus dem Service Worker mit
   `credentials: "include"` (Host-Rechte ⇒ Login-Cookies gehen mit). Bei 401 → `refreshSession()` ruft
   unsichtbar `https://www.vinted.de/` ab (Set-Cookie erneuert `access_token_web` aus `refresh_token_web`) und
   wiederholt einmal. Bei 403/HTML → über einen *bereits offenen* vinted.de-Tab (`pageFetch` per
   `chrome.scripting.executeScript`). Eine DNR-Session-Regel setzt Origin/Referer auf vinted.de.
   **Automatisch wird nie ein Fenster/Tab geöffnet** (Nutzerwunsch). Nur bei Klick auf „Jetzt aktualisieren“
   + Sicherheitsprüfung: normaler Tab (`chrome.tabs.create`), nie `windows.create`.
2. **Sync:** Dashboard ruft alle 60 s (versteckt: 5 min) `{type:"sync"}`; zusätzlich `chrome.alarms` alle 10 min.
   `quick` = Seite 1 jeder Liste + Merge per ID, `full` = alle Seiten (Dashboard-Takt alle 15 min, Alarm alle 60 min).
   Endpunkte: `/api/v2/my_orders?type=purchased|sold&status=all&per_page=20&page=N`,
   `/api/v2/users/{v_uid}/items`, `/api/v2/inbox`, `/api/v2/conversations/{id}`(+`/replies` POST),
   Details: `/api/v2/my_orders/{id}`, `/api/v2/transactions/{id}`.
3. **Fehler:** `AuthError` → `paused:"auth"`, `ChallengeError` → `paused:"challenge"`, `RateLimitError` (429)
   → Backoff 2/4/8/16/30 min (Retry-After respektiert). Lock über `storage.session.sync.lockAt`.
   Nur schreiben, wenn sich Daten geändert haben (sonst rendert das Dashboard jede Minute neu).

## Speicher
- `chrome.storage.local` (dauerhaft): `orders`, `sales`, `listings`, `updatedAt` (von Vinted),
  `meta` (pro Kauf-ID: status, salePrice, soldDate, extraCost, note, private), `saleLinks`
  (saleId → purchaseId | "none"), `manualOrders` (eigene Käufe inkl. Foto als JPEG-DataURL), `costs`, `settings`.
- `chrome.storage.session` (bis Browser-Neustart): `loadState` (Statuszeile), `sync` (Zustand), `detail:<id>`.
- `localStorage` (Extension-Origin, Popup+Dashboard teilen ihn): `theme`, `range`, `metric`, `chartType`, `autoPaused`.
- Test-Button „Daten löschen“ entfernt Vinted-Daten, `meta`, `saleLinks`, `manualOrders` – **nicht** `costs`/`settings`.
- Achtung: ID entpackter Erweiterungen hängt am Ordnerpfad (kein `key` im Manifest) → Ordner verschieben = leerer Speicher.

## Fachliche Regeln (vom Nutzer entschieden – nicht ändern ohne Rückfrage)
- **Datum immer lokal** (`parseDate/dayKey/monthKey`), nie `toISOString()` für Tagesschlüssel (UTC-Verschiebung war ein Bug).
- **Verkäufe** kommen automatisch aus Vinted (stornierte/erstattete raus, `prepareSales`). `linkSales` ordnet per
  Titel-Ähnlichkeit zu (≥ 2 gemeinsame Wörter, Score ≥ 0,5, Kauf vor Verkauf, gierig bester Treffer);
  manuelle `saleLinks` haben Vorrang. Zugeordneter Verkauf ⇒ Kauf-Status „Verkauft“ (überschreibt manuelle Wahl).
  Manuell als verkauft markierte Käufe ohne Vinted-Verkauf zählen als eigener Verkauf; keine Doppelzählung.
- **Geschäftsjahr** = 1.1.–31.12., Standard laufendes Jahr, ältere Jahre per Auswahl, nie vermischt.
  Zeiträume 7 T/30 T/90 T (am 1.1. abgeschnitten) und „Jahr“ (Monatsbalken). Kauf zählt im Kaufjahr,
  Verkauf (inkl. Gewinn mit EK) im Verkaufsjahr. Unverkaufte Ware aus Vorjahren bleibt im Lager (`itemInYear`).
- **Betriebskosten** (`allocateCosts`, in Cent, chronologisch über alle Jahre):
  einmalig = fester Betrag pro verkauftem Stück ab Kaufdatum bis abbezahlt (`paidOffAt`), mehrere **gleichzeitig**;
  monatlich mit Stückzahl = amount/qty pro Verkauf, ohne Stückzahl = amount ÷ Verkäufe des Monats; Vorrat/Monate
  ohne Verkauf kosten nichts. Gilt auch für Verkäufe ohne zugeordneten Kauf. Umsatz brutto, **Gewinn netto**
  (`netProfit`), eigene Kachel „Betriebskosten“.
- **Privat** (`meta[id].private`): nur zur Ansicht – keine Events, keine Summen, kein Lager, keine Zuordnung,
  nicht in Übersicht/Export/Popup, nur unter Chip „🔒 Privat“ (Kaufjahr). Private Sachen werden nie verkauft.
- **Eigene Käufe** (`manualToOrder`, `source:"manual"`): zählen normal, Standardstatus „Im Lager“, Plattform statt Vinted-Status.

## Konventionen
- Vanilla JS, DOM per `el(tag, props, children)` aus `shared.js`; `$()` = getElementById.
- CSS: Farben nur über Tokens (`--bg --surface --ink --muted --line --denim --on-accent --pos --link --p-*`).
  Dark Mode doppelt definiert: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` **und**
  `:root[data-theme="dark"]`. Akzentflächen mit `color: var(--on-accent)` (Kontrast im Dunkeln).
- Kommentare Deutsch, knapp, erklären das *Warum*.
- **Edit-Falle:** Dateien enthalten teils echte Zeichen („–“, „·“, „−“) statt `–` usw. Beim Ersetzen per Skript
  beide Schreibweisen berücksichtigen.

## Prüfen
```bash
for f in *.js; do node --check "$f"; done
for f in tests/*.js; do node "$f"; done   # Logik (Datum, Zuordnung, Kosten, Jahr, Privat) + background.js-Simulation
```
- Tests laden `shared.js`/`background.js` per `vm` mit nachgebautem `chrome`/`fetch` (TZ Europe/Berlin).
- **Screenshots:** Kopie der Dateien in den Scratchpad, `mock.js` mit Fake-`chrome`-API vor `shared.js` einbinden,
  dann Headless-Chrome: `perl -e 'alarm 40; exec @ARGV' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --allow-file-access-from-files --window-size=1440,900 --virtual-time-budget=3000 --screenshot=out.png file://…`
  (`perl alarm` statt `timeout`, das es auf macOS nicht gibt; Headless rendert mindestens 500 px breit;
  ohne `data-theme` greift System = dunkel).
- Nutzer lädt die Erweiterung über `chrome://extensions` → „Neu laden“.

## Versionen (Kurzhistorie)
2.3 Auto-Refresh, Hell/Dunkel, neue Übersicht, Datums-Bugfix · 2.4 Betriebskosten + Geschäftsjahr ·
2.5 Eigene Käufe + Privat · 2.6 Laden ohne Fenster (direkt aus dem Service Worker), 10-min-Alarm ·
2.7 Brücke zur Web-App (Token-Übergabe per Klick, `webapp-bridge.js`) · 2.7.1 Brücke robuster (`document_end`,
Listener zuerst), gibt zusätzlich `access_token_web` mit · 2.7.2 Chip „Privat“ unter Käufe immer sichtbar ·
2.8.0 Brücke gibt nur noch `access_token_web` heraus (`webappToken(sender, fresh)`: erneuert die Browser-Sitzung,
wenn der Token fehlt, in < 30 min abläuft oder `fresh` gesetzt ist) – nie mehr den Refresh-Token, weil Vinted ihn
rotiert und sich Browser und Web-App sonst gegenseitig ausloggen · 2.8.1 `webappStatus` (Version + angemeldet, ohne Token)
und `webappTokenMatch(hash)` (SHA-256-Vergleich, sperrt den Browser-Token für „eigene Sitzung“) · 2.8.2 `refreshSession`
macht nach `GET /` (leitet seit 2026-10 auf `/session-refresh` um, setzt keine Cookies mehr) selbst
`POST /web/api/auth/refresh` mit CSRF, wenn kein frischer `access_token_web` da ist; Fehler `refresh-failed` statt
`not-logged-in`. Zugangs-Token gilt nur 1 h · 2.8.3 Diagnose `lastRefreshDiag` (Status `GET /` + Zielpfad,
CSRF ja/nein, Status `POST`, Restminuten vorher/nachher – nie Token-Werte) in `webappStatus` und bei `refresh-failed` ·
2.8.4 Hintergrund-Anfragen kommen ohne vinted.de-Login-Cookies an (Diagnose: `GET / → 200 (/)` statt `/session-refresh`,
`POST 200` ohne neuen Token) → `refreshInTab`: in offenem vinted.de-Tab per `pageFetch` POST, sonst Tab im Hintergrund
öffnen (`active: false`), erst Vinteds eigene Erneuerung abwarten, dann POST, Tab schließen. Nur für die Web-App
(`refreshSession(..., { tab: true })`); die eigene Automatik öffnet weiterhin nie Tabs. Schwelle 15 min ·
2.8.5 Diagnose zeigte: POST im Tab = 200, aber kein `access_token_web` lesbar → `vintedCookies()` liest auch partitionierte
Cookies (`partitionKey: {}`), `cookieValue` nimmt den mit spätester Ablaufzeit, `tokenFromJson` übernimmt einen Zugang aus
der Antwort (`bodyAccessToken`); Diagnose mit Cookie-Namen/-Eigenschaften (`cookieInventory`, nie Werte) und Antwort-Feldnamen ·
2.8.6 Brücke auch auf `https://jucreative.de` und `https://www.jucreative.de` (Manifest + `WEBAPP_ORIGINS`) ·
2.8.7 Brücke nach Neuladen der Erweiterung („Extension context invalidated“): `send()` antwortet mit `context-invalidated` statt zu werfen, verwaiste Scripts melden kein `hello` mehr. Eigene Angebote über `/api/v2/wardrobe/<id>/items` (Fallback `/users/<id>/items` bei 404, Fehler tragen `status`), geschlossene (`is_closed`) ausgefiltert.
2.8.8 Brücke `send-reply` → `webappSend(sender, msg)`: sendet eine Antwort der Web-App (Postfach, nur nach Klick + Bestätigung dort) im vinted.de-Tab (`pageFetch`, sonst `directFetch` mit CSRF), Zeitgrenze 25 s. **Kontoschutz:** `browserUserId()` (`v_uid`, sonst `sub` des Zugangs-Tokens) muss `expectUserId` sein, sonst `wrong-account` ohne Anfrage. `classifySend`: 2xx `sent`, 4xx `failed`, 5xx/Status 0/Abbruch/Zeitüberschreitung `unclear` – nie ein zweiter Versuch. Grund: Vinted lehnt Antworten vom Server der Web-App mit 400 „Login erforderlich“ ab (nur `access_token_web`, keine Browser-Sitzung). Test `tests/test-webapp-send.js`.
2.9.2 Store-Version: `tools/build-store.mjs` (ohne localhost, schlankes Paket), Server-Auswahl im Popup nur bei mehr als einer Adresse, Manifest-Beschreibung = Store-Zusammenfassung Nr. 1.
2.9.3 `webappSend` sendet über den Messaging-Dienst: `POST https://api.vinted.de/messaging/main/conversations/<uuid>/replies` mit `{ content, is_personal_data_sharing_check_skipped: false, photo_temp_uuids: null }` aus dem vinted.de-Tab (`messagingFetch`: CSRF + Anon-ID aus der Seite, `platform`/`locale`; Werte verlassen den Tab nie). Die Web-App kennt nur die alte Zahlen-ID (= `core_id_deprecated`) ⇒ `resolveConversation` (ab 2.9.4 über die Liste, s. u.), **gesendet wird nur an eine UUID, deren GET `core_id_deprecated` = Zahlen-ID liefert** (gemerkt in `convUuids`); `allow_reply: false` ⇒ `reply-not-allowed`, kein Tab ⇒ `no-tab`, nichts gefunden ⇒ `conversation-not-found` – alles ohne POST. Kein direkter Weg aus dem Service Worker mehr (kein Host-Recht für api.vinted.de, CORS).
2.9.4 UUID-Suche über `GET https://api.vinted.de/messaging/main/inbox` (`?next_cursor=`, 20 je Seite, höchstens 10 Seiten, kurze Pause) statt HTML (die Liste lädt per XHR, das HTML enthält sie nicht). Die Liste hat **kein** `core_id_deprecated` ⇒ Vorauswahl über das Gegenüber (`opposite_users[].data.id` = `otherUserId` von der Web-App), dann Detail-GET mit `core_id_deprecated`-Prüfung, höchstens 6 Detailanfragen. Zeitgrenze Suche 20 s. Bei `conversation-not-found` geht `diag` (nur Zähler/HTTP-Status) mit zurück. Brücke reicht `otherUserId` durch.
Bei neuen Versionen: `manifest.json` hochzählen, `LIESMICH.txt` „Neu in …“ oben ergänzen.
Store-Paket bauen: `node tools/build-store.mjs` → `dist/` (nicht versioniert).
