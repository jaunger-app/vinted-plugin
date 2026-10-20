# Umsetzungsplan 2.9.2 – Store-Version für den Chrome Web Store

Entscheidungen (2026-10-19): Quellcode behält `localhost:3000` für die Entwicklung; ein Build-Skript erzeugt das Store-Paket
ohne Entwicklungsadresse. Server-Auswahl im Popup nur, wenn es mehr als eine Adresse gibt. Manifest-Beschreibung =
Zusammenfassung Nr. 1 aus `../marketing/refold-store/copy/de/store-texte.md`.

1. **Manifest:** `description` → „Verbindet deine Vinted-Anmeldung im Browser mit deinem refold-Dashboard. Anmeldung mit deinem
   refold-Konto.“, Version 2.9.2.
2. **Popup:** `setupServer()` blendet die Server-Auswahl aus, wenn `WEB_BASES` nur eine Adresse hat; Versionsnummer bleibt rechts.
3. **Build-Skript `tools/build-store.mjs`** (Node, ohne Abhängigkeiten) → `dist/refold-<version>-store.zip`:
   - nur benötigte Dateien (kein `shared.js`, keine Tests, nur die Schriften aus `popup.css`),
   - entfernt `http://localhost:3000` aus `host_permissions`, `content_scripts`, `WEB_BASES` (account.js) und
     `WEBAPP_ORIGINS` (background.js),
   - bricht ab, wenn danach noch „localhost“ im Paket steht, eine Ersetzung nicht greift oder `node --check` scheitert.
4. **Test `tests/test-store-build.js`:** baut in einen Temp-Ordner und prüft Manifest, Adresslisten und Dateiliste.
5. **Prüfen:** `node --check`, alle Tests, Gleichheitstest der Web-App (`connect.test.ts`) unverändert grün, Popup mit Store-Stand
   (eine Adresse) als Screenshot.
6. **Doku:** `LIESMICH.txt` „Neu in 2.9.2“, `CLAUDE.md` (Build + Version).
