// Brücke zur Web-App (vinted-webapp, läuft auf http://localhost:3000 bzw. https://jucreative.de).
// Die Seite fragt per window.postMessage nach einem frischen Vinted-Zugangs-Token; der Hintergrund
// liest ihn mit chrome.cookies (HttpOnly, für die Seite unsichtbar) und wir reichen ihn zurück.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const origin = window.location.origin;
  const reply = (data) => window.postMessage({ source: "vinted-ext", ...data }, origin);

  // Wird die Erweiterung neu geladen oder aktualisiert, bleibt dieses Script in offenen Tabs „verwaist“:
  // chrome.runtime.id ist dann leer und sendMessage wirft „Extension context invalidated“.
  // Statt zu werfen (und die Seite auf einen Timeout warten zu lassen) melden wir das als Fehler.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg, cb) => {
    if (!alive()) { cb({ error: "context-invalidated" }); return; }
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        cb(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r || { error: "keine Antwort" });
      });
    } catch {
      cb({ error: "context-invalidated" });
    }
  };

  // Zuerst zuhören – die Seite pingt, sobald sie bereit ist (auch mehrmals).
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== origin) return;
    const d = e.data;
    if (d?.source !== "vinted-webapp") return;
    // Verwaist: keine veraltete Version melden (die neue Erweiterung meldet sich nach dem Neuladen der Seite).
    if (d.type === "ping") { if (alive()) reply({ type: "hello", version: VERSION }); return; }
    if (d.type === "status") send({ type: "webappStatus" }, (r) => reply({ type: "status", id: d.id, ...r }));
    if (d.type === "token-match") send({ type: "webappTokenMatch", hash: String(d.hash || "") }, (r) => reply({ type: "token-match", id: d.id, ...r }));
    if (d.type === "request-token") send({ type: "webappToken", fresh: !!d.fresh }, (r) => reply({ type: "token", id: d.id, ...r }));
  });

  if (document.documentElement) document.documentElement.dataset.vintedExt = VERSION;
  reply({ type: "hello", version: VERSION });
})();
