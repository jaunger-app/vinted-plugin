// Brücke zur Web-App (vinted-webapp, läuft auf http://localhost:3000 bzw. https://jucreative.de).
// Die Seite fragt per window.postMessage nach einem frischen Vinted-Zugangs-Token; der Hintergrund
// liest ihn mit chrome.cookies (HttpOnly, für die Seite unsichtbar) und wir reichen ihn zurück.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const origin = window.location.origin;
  const reply = (data) => window.postMessage({ source: "vinted-ext", ...data }, origin);

  // Zuerst zuhören – die Seite pingt, sobald sie bereit ist (auch mehrmals).
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== origin) return;
    const d = e.data;
    if (d?.source !== "vinted-webapp") return;
    if (d.type === "ping") reply({ type: "hello", version: VERSION });
    if (d.type === "status") {
      chrome.runtime.sendMessage({ type: "webappStatus" }, (r) => {
        reply({ type: "status", id: d.id, ...(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r || { error: "keine Antwort" }) });
      });
    }
    if (d.type === "token-match") {
      chrome.runtime.sendMessage({ type: "webappTokenMatch", hash: String(d.hash || "") }, (r) => {
        reply({ type: "token-match", id: d.id, ...(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r || { error: "keine Antwort" }) });
      });
    }
    if (d.type === "request-token") {
      chrome.runtime.sendMessage({ type: "webappToken", fresh: !!d.fresh }, (r) => {
        if (chrome.runtime.lastError) { reply({ type: "token", id: d.id, error: chrome.runtime.lastError.message }); return; }
        reply({ type: "token", id: d.id, ...(r || { error: "keine Antwort" }) });
      });
    }
  });

  if (document.documentElement) document.documentElement.dataset.vintedExt = VERSION;
  reply({ type: "hello", version: VERSION });
})();
