// Brücke zur Web-App (vinted-webapp; erlaubte Adressen: manifest.json content_scripts + WEBAPP_ORIGINS in background.js).
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
    // 2.8.8: Antwort senden – nur auf ausdrückliche Anfrage der Web-App; der Hintergrund prüft Absender und Konto.
    // 2.9.1: Anmeldung von der Website übernehmen (Seite „Erweiterung verbinden“, auch für Google-Konten) – nur auf Klick dort;
    // der Hintergrund prüft Absender und bestätigt die Sitzung selbst beim Server, bevor er sie speichert.
    if (d.type === "ext-session") send({ type: "webappSession", session: d.session }, (r) => reply({ type: "ext-session", id: d.id, ...r }));
    // 2.9.5 (055): Angebote – Zustand lesen bzw. eine bestätigte Aktion; der Hintergrund prüft Absender, Konto, Angebot und Preis.
    if (d.type === "offer-action") send({
      type: "webappOffer", action: String(d.action || ""), conv: String(d.conv || ""), expectUserId: String(d.expectUserId || ""),
      offerRequestId: String(d.offerRequestId || ""), expectedPrice: d.expectedPrice == null ? null : String(d.expectedPrice),
      price: d.price == null ? null : String(d.price), transactionId: String(d.transactionId || ""), currency: String(d.currency || ""),
      itemIds: Array.isArray(d.itemIds) ? d.itemIds.slice(0, 20).map(String) : [], requestKey: String(d.requestKey || ""),
    }, (r) => reply({ type: "offer-action", id: d.id, ...r }));
    // 2.9.6 (057): optionaler Bildanhang (data:-URL) – der Hintergrund prüft Freigabe, Format und Größe.
    if (d.type === "send-reply") send({ type: "webappSend", conv: String(d.conv || ""), body: String(d.body || ""), expectUserId: String(d.expectUserId || ""), otherUserId: String(d.otherUserId || ""),
      photo: typeof d.photo === "string" ? d.photo : null }, (r) => reply({ type: "send-reply", id: d.id, ...r }));
  });

  if (document.documentElement) document.documentElement.dataset.vintedExt = VERSION;
  reply({ type: "hello", version: VERSION });
})();
