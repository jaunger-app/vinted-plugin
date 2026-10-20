// Konto der Erweiterung (2.9.0): Anmeldung mit demselben refold-Konto wie auf der Website.
//
// Die Erweiterung fragt nie Firebase direkt und kennt keine Schlüssel. Sie spricht nur mit der Web-App:
//   POST /api/extension/login          E-Mail + Passwort → eingeschränkte Erweiterungs-Sitzung (ID- + Refresh-Token)
//   POST /api/extension/refresh        Refresh-Token → neues ID-Token
//   POST /api/extension/password-reset E-Mail → Firebase schickt den Link (Antwort immer gleich)
//   GET  /api/extension/me             prüft die Sitzung serverseitig
// Speicher: Refresh-Token + Konto in chrome.storage.local (nur Erweiterungsseiten, kein Content-Script braucht es),
// das kurzlebige ID-Token nur in chrome.storage.session (weg nach Browser-Neustart). Passwörter werden nie gespeichert.
// Wird im Popup per <script> geladen (globale Funktionen) und in tests/test-account.js per vm geprüft.

const WEB_BASES = ["http://localhost:3000", "https://jucreative.de"];
const AUTH_KEY = "extAuth";
const ID_KEY = "extIdToken";
const REQUEST_TIMEOUT_MS = 12000;
const EARLY_REFRESH_MS = 60 * 1000;

class AccountError extends Error {
  /** kind: credentials | expired | network | rate | server | input */
  constructor(kind, message, status = 0) { super(message); this.kind = kind; this.status = status; }
}

async function getBase() {
  const { webBase } = await chrome.storage.local.get("webBase");
  return WEB_BASES.includes(webBase) ? webBase : WEB_BASES[0];
}
async function setBase(base) {
  if (!WEB_BASES.includes(base)) throw new AccountError("input", "Unbekannte Server-Adresse.");
  await chrome.storage.local.set({ webBase: base });
}
const hostOf = (base) => base.replace(/^https?:\/\//, "");

/** Ein Aufruf an die Web-App; Netzwerkfehler und Statuscodes werden in verständliche Fehler übersetzt. */
async function webRequest(path, { method = "GET", body, token } = {}) {
  const base = await getBase();
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AccountError("network", `Keine Verbindung zu ${hostOf(base)}. Prüfe deine Internetverbindung – oder läuft die Web-App gerade nicht?`);
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.ok !== false) return json;
  const message = typeof json.error === "string" && json.error ? json.error : `Fehler ${res.status}`;
  if (res.status === 401) throw new AccountError(path.includes("/login") ? "credentials" : "expired", message, 401);
  if (res.status === 429) throw new AccountError("rate", message, 429);
  if (res.status === 400) throw new AccountError("input", message, 400);
  if (res.status === 404) throw new AccountError("server", `${hostOf(base)} kennt die Anmeldung der Erweiterung noch nicht (ältere Web-App-Version).`, 404);
  throw new AccountError("server", message, res.status);
}

async function saveSession(s) {
  await chrome.storage.local.set({ [AUTH_KEY]: { refreshToken: s.refreshToken, user: s.user, base: await getBase() } });
  await chrome.storage.session.set({ [ID_KEY]: { idToken: s.idToken, expiresAt: s.expiresAt } });
}
async function clearSession() {
  await chrome.storage.local.remove(AUTH_KEY);
  await chrome.storage.session.remove(ID_KEY);
}
async function storedAccount() {
  const { [AUTH_KEY]: a } = await chrome.storage.local.get(AUTH_KEY);
  // Sitzung gehört zu genau einer Server-Adresse – nach einem Wechsel neu anmelden.
  if (!a?.refreshToken || a.base !== (await getBase())) return null;
  return a;
}

async function login(email, password) {
  const e = String(email || "").trim();
  if (!e || !password) throw new AccountError("input", "Bitte E-Mail und Passwort eingeben.");
  const s = await webRequest("/api/extension/login", { method: "POST", body: { email: e, password } });
  await saveSession(s);
  return s.user;
}

async function logout() { await clearSession(); }

async function requestPasswordReset(email) {
  const e = String(email || "").trim();
  if (!e) throw new AccountError("input", "Gib oben deine E-Mail-Adresse ein, dann schicken wir dir den Link.");
  await webRequest("/api/extension/password-reset", { method: "POST", body: { email: e } });
}

/** Gültiges ID-Token (erneuert kurz vor Ablauf). Abgelaufene Sitzung ⇒ abmelden + AccountError("expired"). */
async function idToken(force = false) {
  const account = await storedAccount();
  if (!account) throw new AccountError("expired", "Bitte melde dich an.");
  const { [ID_KEY]: cur } = await chrome.storage.session.get(ID_KEY);
  if (!force && cur?.idToken && cur.expiresAt - EARLY_REFRESH_MS > Date.now()) return cur.idToken;
  try {
    const s = await webRequest("/api/extension/refresh", { method: "POST", body: { refreshToken: account.refreshToken } });
    await saveSession(s);
    return s.idToken;
  } catch (err) {
    if (err.kind === "expired" || err.status === 400) {
      await clearSession();
      throw new AccountError("expired", "Deine Sitzung ist abgelaufen – bitte melde dich neu an.");
    }
    throw err;
  }
}

/** Aufruf mit Anmeldung; bei 401 einmal mit frischem Token wiederholen. */
async function authedRequest(path, opts = {}) {
  try {
    return await webRequest(path, { ...opts, token: await idToken() });
  } catch (err) {
    if (err.kind !== "expired" || err.status !== 401) throw err;
    return await webRequest(path, { ...opts, token: await idToken(true) });
  }
}

/** Angemeldetes Konto – serverseitig geprüft (nicht nur lokal gespeichert). null = nicht angemeldet. */
async function currentUser() {
  if (!(await storedAccount())) return null;
  const r = await authedRequest("/api/extension/me");
  return r.user;
}
