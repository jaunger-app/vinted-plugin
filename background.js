// Lädt Käufe, Verkäufe und eigene Angebote im Hintergrund – ohne Fenster.
//
// Die Abfragen gehen direkt aus diesem Service Worker an vinted.de. Die
// Erweiterung hat Host-Rechte für vinted.de, dadurch gehen deine Login-Cookies
// mit. Ein abgelaufener Login wird unsichtbar erneuert (Abruf der Startseite).
// Nur wenn Vinted eine Sicherheitsprüfung verlangt, wird ein bereits offener
// vinted.de-Tab mitbenutzt. Automatisch wird nie ein Fenster oder Tab geöffnet;
// nach einem Klick auf „Jetzt aktualisieren“ höchstens ein normaler Tab für die Prüfung.
//
// Zwei Arten von Abgleich:
//   quick – nur Seite 1 jeder Liste, wird mit dem gespeicherten Stand zusammengeführt
//   full  – alle Seiten, ersetzt den Stand
// Die Übersicht stößt alle 60 s einen automatischen Abgleich an ("sync"),
// zusätzlich alle 10 min ein Alarm; hier wird entschieden, ob quick, full
// oder gar nichts (Pause, Wartezeit).

const ORIGIN = "https://www.vinted.de";
const ORDERS_PATH = (type, page) => `/api/v2/my_orders?type=${type}&status=all&per_page=20&page=${page}`;
const FULL_EVERY_MS = { dashboard: 15 * 60 * 1000, alarm: 60 * 60 * 1000 }; // automatischer Voll-Abgleich
const MIN_AUTO_GAP_MS = 45 * 1000;      // nie öfter als das automatisch (mehrere Tabs, Alarm)
const BACKOFF_MS = [2, 4, 8, 16, 30].map((m) => m * 60 * 1000);
const CHALLENGE_WAIT_MS = 180000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const REFRESH_GAP_MS = 5 * 60 * 1000;   // Login höchstens alle 5 min erneuern
const MAX_LISTING_PAGES = 30;
const ALARM = "vinted-sync";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pagePause = () => sleep(1000 + Math.random() * 600);

class AuthError extends Error {}
class RateLimitError extends Error { constructor(retryAfterMs) { super("Vinted bremst gerade (zu viele Anfragen)."); this.retryAfterMs = retryAfterMs; } }
class ChallengeError extends Error {}

// ---------- Zustand (überlebt einen Neustart des Service Workers) ----------

let running = false;

async function getSync() {
  const { sync } = await chrome.storage.session.get("sync");
  return sync || {};
}
async function patchSync(patch) {
  const sync = { ...(await getSync()), ...patch };
  await chrome.storage.session.set({ sync });
  return sync;
}

function setState(text, kind, isRunning) {
  return chrome.storage.session.set({ loadState: { text, kind, running: isRunning, at: Date.now() } });
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

chrome.storage.session.get(["loadState", "sync", "vintedWin"]).then(({ loadState, sync, vintedWin }) => {
  if (loadState?.running && !running) {
    setState("Das Laden wurde unterbrochen. Klicke erneut auf „Jetzt aktualisieren“.", "error", false);
  }
  if (sync?.lockAt && !running) patchSync({ lockAt: null, phase: "idle" });
  // Aufräumen: Das minimierte Vinted-Fenster älterer Versionen wird nicht mehr gebraucht.
  if (vintedWin) {
    chrome.windows.remove(vintedWin).catch(() => {});
    chrome.storage.session.remove("vintedWin");
  }
});

// ---------- Start: Header-Regel und Hintergrund-Alarm ----------

// Anfragen dieser Erweiterung an vinted.de tragen sonst „Origin: chrome-extension://…“.
// Die Regel setzt Origin/Referer auf vinted.de, damit sie aussehen wie von der Seite selbst.
async function setupHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "set", value: ORIGIN },
            { header: "referer", operation: "set", value: `${ORIGIN}/` },
          ],
        },
        condition: { requestDomains: ["www.vinted.de"], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ["xmlhttprequest", "other"] },
      }],
    });
  } catch (e) {
    console.warn("Header-Regel konnte nicht gesetzt werden:", e);
  }
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM).catch(() => null);
  if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 10, delayInMinutes: 1 });
}

setupHeaderRule();
ensureAlarm();
chrome.runtime.onInstalled.addListener(() => { setupHeaderRule(); ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { setupHeaderRule(); ensureAlarm(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) autoSync("alarm"); });

// ---------- Nachrichten ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "load":       runSync("full", { interactive: true }).then(sendResponse); return true;
    case "sync":       autoSync("dashboard").then(sendResponse); return true;
    case "loadDetail": loadDetail(msg.id, msg.conv); break;
    case "inbox":
    case "thread":
    case "send":       msgRequest(msg).then(sendResponse); return true;
    case "webappToken": webappToken(sender, msg.fresh).then(sendResponse); return true;
    case "webappStatus": webappStatus(sender).then(sendResponse); return true;
    case "webappTokenMatch": webappTokenMatch(sender, msg.hash).then(sendResponse); return true;
    case "webappSend": webappSend(sender, msg).then(sendResponse); return true;
  }
});

// Web-App (vinted-webapp) fragt über das Content-Script webapp-bridge.js nach einem frischen
// Zugangs-Token (access_token_web, HttpOnly – für die Seite unsichtbar). Den Refresh-Token gibt es
// bewusst NICHT mehr heraus: Vinted rotiert ihn bei jeder Erneuerung, teilen sich Browser und Server
// denselben, loggen sie sich gegenseitig aus. So erneuert nur der Browser seine eigene Sitzung.
//   fresh = false: nur erneuern, wenn der Zugangs-Token fehlt oder in < 30 min abläuft
//   fresh = true:  der Server hat den Token abgelehnt → Browser-Sitzung jetzt erneuern
const WEBAPP_ORIGINS = ["http://localhost:3000", "https://jucreative.de", "https://www.jucreative.de"];
const ACCESS_MIN_LEFT_MS = 15 * 60 * 1000;
function jwtExpiry(token) {
  try {
    const part = String(token || "").split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}
function webappAllowed(sender) {
  let origin = "";
  try { origin = new URL(sender?.url || "").origin; } catch { /* leer */ }
  return sender?.id === chrome.runtime.id && WEBAPP_ORIGINS.includes(origin);
}
// Cookies von vinted.de – auch partitionierte (CHIPS): die liefert chrome.cookies nur mit partitionKey.
async function vintedCookies(filter = {}) {
  const plain = await chrome.cookies.getAll({ ...filter, domain: "vinted.de" });
  let partitioned = [];
  try { partitioned = await chrome.cookies.getAll({ ...filter, domain: "vinted.de", partitionKey: {} }); } catch { /* ältere Chrome-Version */ }
  const seen = new Set(plain.map((c) => `${c.name}|${c.domain}|${c.path}`));
  return [...plain, ...partitioned.filter((c) => !seen.has(`${c.name}|${c.domain}|${c.path}`))];
}
// Bei mehreren gleichnamigen Cookies den mit der spätesten Ablaufzeit nehmen (nicht einen alten Rest).
const cookieValue = async (name) => {
  const list = (await vintedCookies({ name })).filter((c) => c.value);
  list.sort((a, b) => (b.expirationDate || Infinity) - (a.expirationDate || Infinity));
  return list[0]?.value || null;
};
// Zugangs-Token, den Vinted im Antwort-Text der Erneuerung statt als Cookie liefert (falls so).
let bodyAccessToken = null;
const TOKEN_KEYS = ["access_token", "accessToken", "access_token_web", "token"];
function tokenFromJson(json) {
  if (!json || typeof json !== "object") return null;
  for (const k of TOKEN_KEYS) if (typeof json[k] === "string" && json[k].length > 20) return json[k];
  for (const inner of ["data", "auth", "session"]) {
    const o = json[inner];
    if (o && typeof o === "object") for (const k of TOKEN_KEYS) if (typeof o[k] === "string" && o[k].length > 20) return o[k];
  }
  return null;
}
// Diagnose: nur Namen und Eigenschaften der vinted.de-Cookies, nie Werte.
async function cookieInventory() {
  try {
    return (await vintedCookies()).map((c) => {
      const flags = [c.domain, c.httpOnly ? "httpOnly" : "", c.partitionKey ? "partitioniert" : "", c.sameSite && c.sameSite !== "unspecified" ? c.sameSite : "",
        c.expirationDate ? `${Math.round((c.expirationDate * 1000 - Date.now()) / 60000)} min` : "Sitzung"].filter(Boolean).join(", ");
      return `${c.name} (${flags})`;
    }).sort();
  } catch (e) {
    return [`Cookies nicht lesbar: ${String(e?.message || e).slice(0, 80)}`];
  }
}

// Nur der Zustand für die Checkliste der Web-App – ohne Token.
async function webappStatus(sender) {
  if (!webappAllowed(sender)) return { error: "not-allowed" };
  try {
    let accessMin = null;
    try { accessMin = minutesLeft(await accessLeftMs()); } catch { /* leer */ }
    return { version: chrome.runtime.getManifest().version, loggedIn: !!(await cookieValue("refresh_token_web")), accessMin, lastRefresh: lastRefreshDiag, cookies: await cookieInventory() };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// Sperre gegen „eigene Sitzung“ mit dem Token des normalen Browsers: Die Web-App schickt nur den
// SHA-256-Fingerabdruck des eingefügten Tokens, wir vergleichen mit dem des Browsers.
async function webappTokenMatch(sender, hash) {
  if (!webappAllowed(sender)) return { error: "not-allowed" };
  try {
    const token = await cookieValue("refresh_token_web");
    if (!token || typeof hash !== "string") return { match: false };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { match: hex === hash.toLowerCase() };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function webappToken(sender, fresh) {
  if (!webappAllowed(sender)) return { error: "not-allowed" };
  try {
    const value = cookieValue;
    if (!(await value("refresh_token_web"))) return { error: "not-logged-in" };
    let access = await value("access_token_web");
    const exp = jwtExpiry(access);
    if (fresh) bodyAccessToken = null;
    if (fresh && access) await chrome.cookies.remove({ url: ORIGIN, name: "access_token_web" }).catch(() => {});
    if (fresh || !access || (exp && exp - Date.now() < ACCESS_MIN_LEFT_MS)) {
      // Erst im Hintergrund versuchen, dann (für die Web-App erlaubt) in einem vinted.de-Tab.
      await refreshSession(true, ACCESS_MIN_LEFT_MS, { tab: true });
      access = (await value("access_token_web")) || bodyAccessToken;
    }
    // Angemeldet (Refresh-Token da), aber die Erneuerung hat nicht geklappt – nicht „nicht angemeldet“ melden.
    return access ? { accessToken: access } : { error: "refresh-failed", diag: lastRefreshDiag };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ---------- Senden für die Web-App (2.8.8) ----------
// Vinted nimmt Antworten nur mit der echten Browser-Sitzung an (der Server der Web-App bekommt sonst
// „Login erforderlich“). Deshalb sendet die Erweiterung – nur auf ausdrückliche Anfrage der Web-App (Klick +
// Bestätigung dort), nie automatisch, und nur, wenn im Browser genau das erwartete Vinted-Konto angemeldet ist.
const SEND_TIMEOUT_MS = 25000;
const MAX_SEND_BODY = 4000;

/** Ergebnis einordnen wie der Server der Web-App: sent | failed (sicher nicht angekommen) | unclear (unbekannt). */
function classifySend(r) {
  if (!r) return { status: "unclear", httpStatus: 0, error: "keine Antwort" };
  if (r.ok) return { status: "sent", httpStatus: r.status };
  if (!r.status) return { status: "unclear", httpStatus: 0, error: r.error || "Verbindung abgebrochen" };
  if (r.status >= 500) return { status: "unclear", httpStatus: r.status, error: `Vinted-Fehler ${r.status}` };
  const msg = r.json && typeof r.json.message === "string" ? r.json.message.slice(0, 200) : "";
  return { status: "failed", httpStatus: r.status, error: msg ? `Fehler ${r.status}: ${msg}` : `Fehler ${r.status}` };
}
/** Nutzer-ID aus einem Vinted-JWT (sub, user_id oder uid – wie tokenSubject im Server der Web-App). */
function jwtSub(token) {
  try {
    const part = String(token || "").split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    const v = json.sub ?? json.user_id ?? json.uid;
    return v != null && /^\d+$/.test(String(v)) ? String(v) : null;
  } catch {
    return null;
  }
}
/**
 * Vinted-Nutzer-ID des im Browser angemeldeten Kontos. Reihenfolge: Cookie v_uid → Zugangs-Token → Refresh-Token
 * (nur lokal gelesen, nie weitergegeben) → /api/v2/users/current im vinted.de-Tab. null = unbekannt (dann nicht senden).
 */
async function browserUserId(tab) {
  const v = await cookieValue("v_uid");
  if (v && /^\d+$/.test(v)) return v;
  const fromToken = jwtSub(await cookieValue("access_token_web")) || jwtSub(bodyAccessToken) || jwtSub(await cookieValue("refresh_token_web"));
  if (fromToken) return fromToken;
  if (!tab) return null;
  const r = await pageFetch(tab.id, "/api/v2/users/current").catch(() => null);
  const id = r && r.ok && r.json && r.json.user && r.json.user.id;
  return id != null && /^\d+$/.test(String(id)) ? String(id) : null;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res({ ok: false, status: 0, error: "Zeitüberschreitung" }), ms))]);

async function webappSend(sender, msg) {
  if (!webappAllowed(sender)) return { status: "failed", error: "not-allowed" };
  const conv = String(msg?.conv ?? "");
  const body = typeof msg?.body === "string" ? msg.body.trim() : "";
  if (!/^\d{1,20}$/.test(conv)) return { status: "failed", error: "bad-conversation" };
  if (!body || body.length > MAX_SEND_BODY) return { status: "failed", error: "bad-body" };
  // Vor dem Absenden: alles, was hier scheitert, ist sicher nicht gesendet.
  let tab;
  try {
    if (!(await cookieValue("refresh_token_web"))) return { status: "failed", error: "not-logged-in" };
    // Abgelaufener Zugang im Browser: zuerst erneuern (wie für den Token der Web-App, notfalls im vinted.de-Tab) –
    // sonst lehnt Vinted die Antwort mit 401 ab und das Konto ist nicht erkennbar.
    if ((await accessLeftMs()) < ACCESS_FRESH_MS) await refreshSession(true, ACCESS_FRESH_MS, { tab: true });
    tab = await findVintedTab();
    const me = await browserUserId(tab);
    if (!me) return { status: "failed", error: "unknown-account", diag: lastRefreshDiag };
    if (String(msg?.expectUserId || "") !== me) return { status: "failed", error: "wrong-account" };
    if (!tab && !csrfToken) await refreshSession(true);
  } catch (e) {
    return { status: "failed", error: String(e?.message || e) };
  }
  const path = `/api/v2/conversations/${encodeURIComponent(conv)}/replies`;
  const opts = { method: "POST", body: { reply: { body } } };
  try {
    const r = tab
      ? await withTimeout(pageFetch(tab.id, path, opts), SEND_TIMEOUT_MS)
      : await withTimeout(directFetch(path, { ...opts, csrf: csrfToken }), SEND_TIMEOUT_MS);
    return { ...classifySend(r), via: tab ? "tab" : "direct" };
  } catch (e) {
    // z. B. Tab während des Sendens geschlossen – ob Vinted die Anfrage bekam, ist unbekannt.
    return { status: "unclear", httpStatus: 0, error: String(e?.message || e), via: tab ? "tab" : "direct" };
  }
}

// ---------- Verbindung zu Vinted (ohne Fenster) ----------

let lastTransport = "direct";
let csrfToken = null;

function looksLikeChallenge(text) {
  return /just a moment|cf-|challenge|attention required|captcha/i.test(String(text || "").slice(0, 2000));
}

// fetch direkt aus dem Service Worker. Ergebnis wie pageFetch: {ok,status,json,text,retryAfter}.
async function directFetch(path, options) {
  try {
    const headers = { "Accept": "application/json" };
    let body;
    if (options && options.body != null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
      if (options.csrf) headers["X-CSRF-Token"] = options.csrf;
    }
    const r = await fetch(ORIGIN + path, {
      method: (options && options.method) || "GET",
      headers, body, credentials: "include", cache: "no-store",
    });
    const raw = await r.text().catch(() => "");
    let json = null, text = "";
    try { json = JSON.parse(raw); } catch { text = raw.slice(0, 2000); }
    return { ok: r.ok, status: r.status, json, text, retryAfter: r.headers.get("retry-after") };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

// Erneuert die Vinted-Anmeldung des Browsers – so wie vinted.de selbst:
//   1. GET /  (liefert die CSRF-Token; früher setzte Vinted hier schon den neuen Zugangs-Token)
//   2. Seit 2026-10 leitet „/“ aber auf /session-refresh um, eine Seite, deren JavaScript
//      POST /web/api/auth/refresh aufruft. Fehlt danach ein frischer access_token_web, machen wir
//      diesen Aufruf selbst. Origin/Referer setzt die Header-Regel (setupHeaderRule) auf vinted.de.
// Rotiert wird dabei nur der Token im Cookie-Speicher des Browsers – derselbe, den die vinted.de-Tabs nutzen.
// Ergebnis: true, wenn danach ein gültiger Zugangs-Token da ist (bzw. die Seite ok war, falls Cookies nicht lesbar).
let refreshPromise = null;
let lastRefresh = 0;
const ACCESS_FRESH_MS = 2 * 60 * 1000;
// Diagnose des letzten Erneuerungsversuchs – nur Status-Codes, Pfade und Ja/Nein, nie Token-Werte.
let lastRefreshDiag = null;
const minutesLeft = (ms) => (ms === Infinity ? null : Math.round(ms / 60000));
function parseCsrf(html) {
  const m = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i.exec(html)
    || /<meta[^>]+content="([^"]+)"[^>]+name="csrf-token"/i.exec(html)
    || /"csrf_?token"\s*:\s*"([^"]+)"/i.exec(html)
    || /CSRF_TOKEN\\?"\s*:\s*\\?"([^"\\]+)/.exec(html);
  return m ? m[1] : null;
}
async function accessLeftMs() {
  const token = (await cookieValue("access_token_web")) || bodyAccessToken;
  if (!token) return 0;
  const exp = jwtExpiry(token);
  return exp == null ? Infinity : exp - Date.now();
}
// opts.tab: Klappt es im Hintergrund nicht, in einem vinted.de-Tab erneuern (siehe refreshInTab).
function refreshSession(force = false, minLeftMs = ACCESS_FRESH_MS, opts = {}) {
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() - lastRefresh < REFRESH_GAP_MS) return Promise.resolve(false);
  const diag = { at: new Date().toISOString(), home: null, homePath: null, csrf: false, accessBefore: null, post: null, postKeys: null, accessAfter: null, tab: null, tabPost: null, tabKeys: null, bodyToken: false, cookies: null, error: null };
  lastRefreshDiag = diag;
  refreshPromise = (async () => {
    try {
      try { diag.accessBefore = minutesLeft(await accessLeftMs()); } catch { /* Cookies nicht lesbar */ }
      const r = await fetch(`${ORIGIN}/`, { credentials: "include", cache: "no-store", headers: { "Accept": "text/html" } });
      diag.home = r.status;
      try { diag.homePath = new URL(r.url).pathname; } catch { /* leer */ }
      const csrf = parseCsrf(await r.text().catch(() => ""));
      if (csrf) csrfToken = csrf;
      diag.csrf = !!csrfToken;
      let left;
      try { left = await accessLeftMs(); } catch { return r.ok; } // Cookies nicht lesbar → wie früher
      diag.accessAfter = minutesLeft(left);
      if (left >= minLeftMs) return true;
      const headers = { "Accept": "application/json, text/plain, */*", "Content-Type": "application/json" };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      const p = await fetch(`${ORIGIN}/web/api/auth/refresh`, { method: "POST", credentials: "include", cache: "no-store", headers, body: "{}" });
      diag.post = p.status;
      try {
        const json = JSON.parse(await p.text());
        diag.postKeys = Object.keys(json || {}).slice(0, 12);
        const t = tokenFromJson(json);
        if (t) { bodyAccessToken = t; diag.bodyToken = true; }
      } catch { diag.postKeys = null; }
      left = await accessLeftMs();
      diag.accessAfter = minutesLeft(left);
      if (left >= minLeftMs) return true;
      // Aus dem Hintergrund schickt Chrome die Login-Cookies von vinted.de nicht immer mit (Anfrage gilt als
      // „fremde Seite“) – dann bleibt GET / auf „/“ statt nach /session-refresh. Im vinted.de-Tab klappt es.
      if (!opts.tab) return false;
      left = await refreshInTab(minLeftMs, diag);
      diag.accessAfter = minutesLeft(left);
      return left >= minLeftMs;
    } catch (e) {
      diag.error = String(e?.message || e).slice(0, 120);
      return false;
    } finally {
      diag.cookies = await cookieInventory();
      lastRefresh = Date.now();
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// Erneuern im Kontext von vinted.de selbst (Cookies werden dort immer mitgeschickt):
//   offener vinted.de-Tab → dort POST /web/api/auth/refresh (mit CSRF aus der Seite)
//   kein Tab → einen Tab im Hintergrund öffnen (nicht aktiv). Vinted erneuert beim Laden selbst
//   (/session-refresh); erst wenn das nicht reicht, der POST. Danach wird der Tab wieder geschlossen.
// Nie zwei Erneuerungen gleichzeitig: beim neuen Tab zuerst abwarten, ob Vinted selbst erneuert.
const TAB_LOAD_MS = 15000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForAccess(minLeftMs, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await accessLeftMs()) >= minLeftMs) return true;
    await sleepMs(500);
  }
  return false;
}
async function waitTabComplete(tabId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await sleepMs(300);
  }
  return false;
}
async function refreshInTab(minLeftMs, diag) {
  let tab = await findVintedTab();
  let opened = false;
  try {
    if (!tab) {
      tab = await chrome.tabs.create({ url: `${ORIGIN}/`, active: false });
      opened = true;
      diag.tab = "opened";
      await waitTabComplete(tab.id, TAB_LOAD_MS);
      if (await waitForAccess(minLeftMs, 6000)) return accessLeftMs(); // Vinted hat selbst erneuert
    } else {
      diag.tab = "existing";
    }
    const r = await pageFetch(tab.id, "/web/api/auth/refresh", { method: "POST", body: {} });
    diag.tabPost = r?.status ?? null;
    diag.tabKeys = r?.json ? Object.keys(r.json).slice(0, 12) : null;
    const t = tokenFromJson(r?.json);
    if (t) { bodyAccessToken = t; diag.bodyToken = true; }
    await waitForAccess(minLeftMs, 3000);
    return accessLeftMs();
  } catch (e) {
    diag.error = String(e?.message || e).slice(0, 120);
    return accessLeftMs().catch(() => 0);
  } finally {
    if (opened && tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const isAuthFail = (r) => r.status === 401 || r.json?.message_code === "invalid_authentication_token";
// 403 (Cloudflare/DataDome) oder eine HTML-Seite, wo JSON erwartet wurde.
const isBlocked = (r) => r.status === 403 || (r.status !== 0 && !r.json && (r.ok || looksLikeChallenge(r.text)));

// Ein bereits offener vinted.de-Tab des Nutzers – wird nur mitbenutzt, nie geöffnet oder umgeleitet.
async function findVintedTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.vinted.de/*" }).catch(() => []);
  return tabs.find((t) => t.status === "complete" && !t.discarded) || null;
}

// Führt fetch in einem vinted.de-Tab aus (GET oder POST) und gibt {ok,status,json,text,retryAfter} zurück.
async function pageFetch(tabId, path, options) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [path, options || null],
    func: async (p, opt) => {
      try {
        const headers = { "Accept": "application/json" };
        let body;
        if (opt && opt.body != null) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(opt.body);
          // CSRF-Token, das Vinted im <meta> oder window ablegt, mitsenden.
          const meta = document.querySelector('meta[name="csrf-token"]');
          const token = (meta && meta.content) || (window.__vinted_csrf_token) || null;
          if (token) headers["X-CSRF-Token"] = token;
        }
        const r = await fetch(p, {
          method: (opt && opt.method) || "GET",
          headers, body, credentials: "include",
        });
        let json = null; let text = "";
        try { json = await r.clone().json(); } catch { text = await r.text().catch(() => ""); }
        return { ok: r.ok, status: r.status, json, text: text.slice(0, 2000), retryAfter: r.headers.get("retry-after") };
      } catch (e) { return { ok: false, status: 0, error: String(e) }; }
    },
  });
  return result;
}

// Eine Anfrage an vinted.de: direkt → bei abgelaufenem Login erneuern und wiederholen
// → bei Sicherheitsprüfung über einen offenen vinted.de-Tab.
async function vintedFetch(path, options) {
  let r = await directFetch(path, options);
  if (isAuthFail(r) && await refreshSession()) r = await directFetch(path, options);
  if (isBlocked(r)) {
    const tab = await findVintedTab();
    if (tab) {
      const viaTab = await pageFetch(tab.id, path, options).catch(() => null);
      if (viaTab) { lastTransport = "tab"; return viaTab; }
    }
    return r;
  }
  lastTransport = "direct";
  return r;
}

// GET auf eine API-Adresse; wirft je nach Antwort einen passenden Fehler.
async function apiGet(path) {
  const r = await vintedFetch(path);
  if (r.ok && r.json) return r.json;
  if (isAuthFail(r)) {
    throw new AuthError("Du bist bei vinted.de nicht angemeldet. Melde dich an und klicke auf „Jetzt aktualisieren“.");
  }
  if (r.status === 429) {
    const sec = parseInt(r.retryAfter, 10);
    throw new RateLimitError(Number.isFinite(sec) ? sec * 1000 : null);
  }
  if (isBlocked(r)) throw new ChallengeError("Vinted möchte eine Sicherheitsprüfung.");
  if (r.status === 0) throw new Error(`Netzwerkfehler (${r.error || "keine Verbindung"}).`);
  throw Object.assign(new Error(`Vinted antwortet mit Fehler ${r.status}.`), { status: r.status });
}

// Nur nach Klick auf „Jetzt aktualisieren“: Bei einer Sicherheitsprüfung einen
// normalen vinted.de-Tab zeigen (vorhandenen nach vorn holen oder einen neuen
// im aktuellen Fenster öffnen) und warten, bis die Prüfung erledigt ist.
async function apiGetInteractive(path) {
  const start = Date.now();
  let shown = false;
  for (;;) {
    try {
      return await apiGet(path);
    } catch (e) {
      if (!(e instanceof ChallengeError) || Date.now() - start > CHALLENGE_WAIT_MS) throw e;
      if (!shown) {
        shown = true;
        await setState("Vinted möchte eine Sicherheitsprüfung – bitte im Vinted-Tab abschließen, danach geht es automatisch weiter.", "warn", true);
        const tab = await findVintedTab();
        if (tab) {
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        } else {
          await chrome.tabs.create({ url: `${ORIGIN}/`, active: true }).catch(() => {});
        }
      }
      await sleep(3000);
    }
  }
}

// ---------- Listen laden ----------

function slim(o) {
  return {
    id: o.transaction_id,
    title: String(o.title || "").replace(/\s+/g, " ").trim(),
    amount: parseFloat(o.price?.amount) || 0,
    status: String(o.status || "").trim(),
    userStatus: o.transaction_user_status || "",
    date: o.date,
    photo: o.photo_url || o.photo?.url || "",
    conv: o.conversation_id || "",
  };
}

function slimListing(it) {
  const p = it.price;
  const amount = p && typeof p === "object" ? parseFloat(p.amount) : parseFloat(p);
  return {
    id: it.id,
    title: String(it.title || "").replace(/\s+/g, " ").trim(),
    brand: it.brand_title || it.brand?.title || "",
    size: it.size_title || it.size || "",
    price: Number.isFinite(amount) ? amount : 0,
    currency: (p && p.currency_code) || it.currency || "EUR",
    views: it.view_count ?? it.stats?.view_count ?? 0,
    favourites: it.favourite_count ?? it.favorite_count ?? 0,
    photo: it.photo?.url || (Array.isArray(it.photos) && it.photos[0]?.url) || "",
    login: it.user?.login || "",
    date: it.created_at_ts || it.updated_at_ts || it.created_at || null,
    reserved: !!it.is_reserved,
    draft: !!it.is_draft,
    hidden: it.is_visible === false,
    url: it.url || `${ORIGIN}/items/${it.id}`,
  };
}

// Blättert durch eine Liste. get(path) holt eine Seite, pick(data) liefert die Einträge.
async function fetchPages(get, pathFor, pick, maxPages, onPage) {
  const raw = [];
  let page = 1, totalPages = 1;
  do {
    if (onPage) await onPage(page, totalPages);
    const data = await get(pathFor(page));
    const arr = pick(data);
    if (!Array.isArray(arr)) {
      if (page === 1) throw new Error(`Vinted hat keine Liste geliefert (${data?.message || "unbekannte Antwort"}).`);
      break;
    }
    raw.push(...arr);
    totalPages = data.pagination?.total_pages || 1;
    page += 1;
    if (page <= Math.min(totalPages, maxPages)) await pagePause();
  } while (page <= Math.min(totalPages, maxPages));
  return raw;
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((o) => !seen.has(o.id) && seen.add(o.id));
};

async function getUserId(get) {
  try {
    const c = await chrome.cookies.get({ url: ORIGIN, name: "v_uid" });
    if (c && /^\d+$/.test(c.value)) return c.value;
  } catch { /* cookies evtl. nicht verfügbar */ }
  const me = await get("/api/v2/users/current");
  return me?.user?.id ? String(me.user.id) : null;
}

// Neue/aktualisierte Einträge (Seite 1) in den gespeicherten Stand einarbeiten.
function mergeById(stored, fresh) {
  const map = new Map((Array.isArray(stored) ? stored : []).map((o) => [o.id, o]));
  for (const o of fresh) map.set(o.id, o);
  return [...map.values()];
}
const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

// ---------- Abgleich ----------

async function autoSync(source = "dashboard") {
  const sync = await getSync();
  const now = Date.now();
  if (sync.paused) return { ok: false, skipped: "paused", sync };
  if (sync.backoffUntil && now < sync.backoffUntil) return { ok: false, skipped: "backoff", sync };
  if (sync.lastAttempt && now - sync.lastAttempt < MIN_AUTO_GAP_MS) return { ok: true, skipped: "recent", sync };
  const fullEvery = FULL_EVERY_MS[source] || FULL_EVERY_MS.dashboard;
  const mode = !sync.lastFull || now - sync.lastFull > fullEvery ? "full" : "quick";
  return runSync(mode, { interactive: false });
}

async function runSync(mode, { interactive }) {
  if (running) return { ok: false, skipped: "running", sync: await getSync() };
  const lock = (await getSync()).lockAt;
  if (lock && Date.now() - lock < LOCK_STALE_MS) return { ok: false, skipped: "running", sync: await getSync() };
  running = true;
  const sync0 = await patchSync({ lockAt: Date.now(), phase: "running", mode, lastAttempt: Date.now() });

  if (interactive) {
    setBadge("…", "#23325a");
    await setState("Verbinde mit Vinted …", "info", true);
  }

  try {
    const get = interactive ? apiGetInteractive : apiGet;
    const full = mode === "full";
    const maxPages = full ? 1000 : 1;
    const progress = (label) => interactive
      ? (page, total) => setState(`Lade ${label}${total > 1 ? ` – Seite ${page} von ${total}` : ""} …`, "info", true)
      : null;

    const ordersRaw = await fetchPages(get, (p) => ORDERS_PATH("purchased", p), (d) => d?.my_orders, maxPages, progress("Käufe"));

    // Verkäufe und Angebote sind optional – ein Fehler dort verwirft die Käufe nicht.
    // Nur Anmelde-, Bremse- und Prüfungsfehler brechen ab, die betreffen alles.
    const optional = async (fn, label) => {
      try { return await fn(); } catch (e) {
        if (e instanceof AuthError || e instanceof RateLimitError || e instanceof ChallengeError) throw e;
        console.warn(`${label} konnten nicht geladen werden:`, e);
        return null;
      }
    };
    await pagePause();
    const salesRaw = await optional(
      () => fetchPages(get, (p) => ORDERS_PATH("sold", p), (d) => d?.my_orders, maxPages, progress("Verkäufe")), "Verkäufe");
    await pagePause();
    const listingsRaw = await optional(async () => {
      const uid = await getUserId(get);
      if (!uid) throw new Error("Benutzer-ID nicht gefunden.");
      // Vinted hat den Pfad geändert (alt /users/<id>/items → 404, 2026-10): zuerst der Kleiderschrank, bei 404 der alte.
      // Der Kleiderschrank liefert auch geschlossene („als verkauft markiert“ zum Relisten) – die zeigt das Plugin nicht.
      let last = null;
      for (const base of [`/api/v2/wardrobe/${uid}/items`, `/api/v2/users/${uid}/items`]) {
        try {
          const items = await fetchPages(get, (p) => `${base}?page=${p}&per_page=20&order=relevance`,
            (d) => d?.items, full ? MAX_LISTING_PAGES : 1, progress("Angebote"));
          return items.filter((it) => it?.is_closed !== true);
        } catch (e) {
          if (e?.status === 404) { last = e; continue; }
          throw e;
        }
      }
      throw last;
    }, "Angebote");

    const stored = await chrome.storage.local.get(["orders", "sales", "listings"]);
    const fresh = {
      orders: dedupe(ordersRaw.map(slim)),
      sales: salesRaw ? dedupe(salesRaw.map(slim)) : null,
      listings: listingsRaw ? dedupe(listingsRaw.map(slimListing)) : null,
    };
    const next = {};
    for (const key of ["orders", "sales", "listings"]) {
      if (!fresh[key]) continue; // nicht geladen → alten Stand behalten
      let list = full ? fresh[key] : mergeById(stored[key], fresh[key]);
      if (key !== "listings") list = list.sort(byDateDesc);
      // Nur schreiben, wenn sich etwas geändert hat – sonst zeichnet die Übersicht jede Minute neu.
      if (JSON.stringify(list) !== JSON.stringify(stored[key] || [])) next[key] = list;
    }
    await chrome.storage.local.set({ ...next, updatedAt: Date.now() });

    await patchSync({
      phase: "idle", lockAt: null, lastOk: Date.now(), transport: lastTransport, ...(full ? { lastFull: Date.now() } : {}),
      error: null, errorKind: null, paused: null, backoffStep: 0, backoffUntil: null,
    });
    if (interactive) {
      const counts = await chrome.storage.local.get(["orders", "sales", "listings"]);
      await setState(`${counts.orders?.length || 0} Käufe, ${counts.sales?.length || 0} Verkäufe und ${counts.listings?.length || 0} Angebote geladen.`, "ok", false);
    } else if (sync0.paused || sync0.errorKind) {
      // Ein vorheriger Hinweis (Bremse, Prüfung) ist erledigt.
      await setState("Verbindung zu Vinted wieder ok.", "ok", false);
    }
    setBadge("");
    return { ok: true, mode, changed: Object.keys(next), sync: await getSync() };
  } catch (err) {
    const sync = await handleSyncError(err, interactive);
    return { ok: false, error: err.message, sync };
  } finally {
    running = false;
    const s = await getSync();
    if (s.lockAt) await patchSync({ lockAt: null, phase: "idle" });
  }
}

async function handleSyncError(err, interactive) {
  const base = { phase: "idle", lockAt: null, error: err.message };
  let sync;
  if (err instanceof RateLimitError) {
    // Exponentiell länger warten; einen Retry-After-Header von Vinted respektieren.
    const step = Math.min(((await getSync()).backoffStep || 0), BACKOFF_MS.length - 1);
    const wait = Math.max(BACKOFF_MS[step], err.retryAfterMs || 0);
    const until = Date.now() + wait;
    sync = await patchSync({ ...base, errorKind: "ratelimit", backoffStep: step + 1, backoffUntil: until });
    const at = new Date(until).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    await setState(`Vinted bremst gerade (zu viele Anfragen). Nächster automatischer Versuch um ${at}.`, "warn", false);
  } else if (err instanceof AuthError) {
    sync = await patchSync({ ...base, errorKind: "auth", paused: "auth" });
    await setState(err.message, "error", false);
  } else if (err instanceof ChallengeError) {
    sync = await patchSync({ ...base, errorKind: "challenge", paused: "challenge" });
    await setState("Vinted möchte eine Sicherheitsprüfung. Klicke auf „Jetzt aktualisieren“ – vinted.de öffnet sich als normaler Tab, dort kurz bestätigen, danach läuft die automatische Aktualisierung weiter.", "warn", false);
  } else {
    sync = await patchSync({ ...base, errorKind: "other" });
    // Einzelne Aussetzer beim automatischen Abgleich nicht groß melden, der nächste Takt versucht es erneut.
    if (interactive) await setState(err.message, "error", false);
  }
  if (interactive || err instanceof AuthError) setBadge("!", "#c9746b");
  return sync;
}

// ---------- Postfach (Chat) ----------
// Gesendet wird ausschließlich nach deinem Klick, nie automatisch.

async function msgRequest(msg) {
  try {
    if (msg.type === "inbox") {
      const page = msg.page || 1;
      const r = await vintedFetch(`/api/v2/inbox?page=${page}&per_page=20`);
      if (!r.ok) return { ok: false, error: r.status === 401 ? "nicht angemeldet" : r.status === 429 ? "zu viele Anfragen, bitte kurz warten" : `Fehler ${r.status}` };
      return { ok: true, data: r.json };
    }
    if (msg.type === "thread") {
      const r = await vintedFetch(`/api/v2/conversations/${encodeURIComponent(msg.id)}`);
      if (!r.ok) return { ok: false, error: `Fehler ${r.status}` };
      return { ok: true, data: r.json };
    }
    if (msg.type === "send") {
      // Senden am liebsten über einen offenen vinted.de-Tab (dort liegt das CSRF-Token),
      // sonst direkt mit dem Token aus der Startseite.
      const path = `/api/v2/conversations/${encodeURIComponent(msg.id)}/replies`;
      const opts = { method: "POST", body: { reply: { body: msg.body } } };
      const tab = await findVintedTab();
      let r;
      if (tab) {
        r = await pageFetch(tab.id, path, opts);
      } else {
        if (!csrfToken) await refreshSession(true);
        r = await directFetch(path, { ...opts, csrf: csrfToken });
      }
      if (!r.ok) {
        if (r.status === 0) return { ok: false, error: r.error || "Netzwerkfehler" };
        return { ok: false, error: tab ? `Fehler ${r.status}` : `Fehler ${r.status} – öffne vinted.de in einem Tab und sende dann erneut` };
      }
      return { ok: true, data: r.json };
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- Einzelne Bestellung: Versand & Details ----------
// Vinted liefert Tracking, Versanddienstleister, Ziel und weitere Fotos nicht in
// der Liste, sondern erst beim Öffnen einer Bestellung. Der genaue Endpunkt ist
// nicht dokumentiert, daher werden ein paar plausible Adressen nacheinander
// probiert und die erste brauchbare JSON-Antwort verwendet.

async function loadDetail(id, conv) {
  const key = `detail:${id}`;
  await chrome.storage.session.set({ [key]: { status: "loading", at: Date.now() } });
  try {
    const candidates = [
      `/api/v2/my_orders/${encodeURIComponent(id)}`,
      `/api/v2/transactions/${encodeURIComponent(id)}`,
      conv ? `/api/v2/conversations/${encodeURIComponent(conv)}` : null,
    ].filter(Boolean);

    let data = null, source = null, listOnly = false;
    for (const [idx, path] of candidates.entries()) {
      if (idx > 0) await pagePause();
      let json;
      try {
        json = await apiGet(path);
      } catch (e) {
        if (e instanceof ChallengeError) throw new Error("Vinted möchte eine Sicherheitsprüfung. Klicke links auf „Jetzt aktualisieren“, schließe sie ab und lade die Details dann erneut.");
        if (e instanceof AuthError || e instanceof RateLimitError) throw e;
        continue; // 404 o. ä. → nächsten Endpunkt probieren
      }
      if (!json || typeof json !== "object") continue;
      if (json.my_orders) { listOnly = true; continue; }
      data = json; source = ORIGIN + path; break;
    }
    if (!data && listOnly) {
      await chrome.storage.session.set({ [key]: { status: "error", message: "Dieser Endpunkt liefert nur die Bestellliste. Bitte sende mir die Antwort beim Öffnen einer Bestellung, dann ergänze ich den richtigen Endpunkt.", at: Date.now() } });
      return;
    }
    if (!data) throw new Error("Keine Detaildaten erhalten. Prüfe, ob du bei vinted.de angemeldet bist.");
    await chrome.storage.session.set({ [key]: { status: "ok", data, source, at: Date.now() } });
  } catch (e) {
    await chrome.storage.session.set({ [key]: { status: "error", message: e.message, at: Date.now() } });
  }
}
