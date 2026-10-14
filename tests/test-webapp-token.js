// Brücke zur Web-App (2.8.0): gibt nur den Zugangs-Token heraus, nie den Refresh-Token,
// und erneuert die Browser-Sitzung nur, wenn nötig (fehlt / läuft bald ab / fresh).
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");

const jwt = (expMs) => "h." + Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url") + ".s";

// how: "post" = wie vinted.de seit 2026-10 (erst POST /web/api/auth/refresh setzt die Tokens),
//      "home" = früheres Verhalten (schon GET / setzt sie), "fail" = Erneuerung klappt nicht.
// tabs: undefined = keine Tab-API (wie test-bg), "none" = kein vinted.de-Tab offen, "open" = Tab offen.
// how "nocookie": Hintergrund-Anfragen kommen ohne Login-Cookies an (nichts wird erneuert), im Tab klappt es.
function makeEnv(jar, how = "post", tabs) {
  const calls = { refresh: 0, removed: [], post: 0, tabCreated: 0, tabRemoved: 0, tabPost: 0 };
  const ev = () => ({ addListener() {} });
  const area = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {} });
  const chrome = {
    storage: { session: area(), local: area() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { id: "ext", onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => p, getManifest: () => ({ version: "2.8.1" }) },
    alarms: { get: async () => null, create() {}, onAlarm: ev() },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    ...(tabs ? {
      tabs: {
        query: async () => (tabs === "open" ? [{ id: 5, status: "complete", url: "https://www.vinted.de/" }] : []),
        create: async () => { calls.tabCreated++; return { id: 9 }; },
        get: async (id) => ({ id, status: "complete" }),
        remove: async () => { calls.tabRemoved++; },
      },
      scripting: { executeScript: async () => {
        calls.tabPost++;
        if (how === "jsonbody") return [{ result: { ok: true, status: 200, json: { access_token: jwt(Date.now() + 3600e3), expires_in: 3600 } } }];
        if (jar.refresh_token_web) jar.access_token_web = jwt(Date.now() + 3600e3);
        return [{ result: { ok: true, status: 200 } }];
      } },
    } : {}),
    cookies: {
      get: async ({ name }) => (jar[name] ? { value: jar[name] } : null),
      // Schlüssel "p:<name>" = partitionierter Cookie (nur mit partitionKey sichtbar)
      getAll: async ({ name, partitionKey }) => partitionKey
        ? (jar[`p:${name}`] ? [{ name, value: jar[`p:${name}`], domain: "www.vinted.de", path: "/", partitionKey: { topLevelSite: "https://vinted.de" } }] : [])
        : (jar[name] ? [{ name, value: jar[name], domain: ".vinted.de", path: "/" }] : []),
      remove: async ({ name }) => { calls.removed.push(name); delete jar[name]; },
    },
  };
  // Erneuern über die Startseite: der Browser bekommt einen neuen Zugangs-Token in seinen Cookie-Speicher.
  const fetch = async (url, init = {}) => {
    const issue = () => { if (jar.refresh_token_web) jar.access_token_web = jwt(Date.now() + 3600e3); };
    if (url === "https://www.vinted.de/") { calls.refresh++; if (how === "home") issue(); return { ok: true, status: 200, text: async () => '<meta name="csrf-token" content="C1">', headers: { get: () => null } }; }
    if (url === "https://www.vinted.de/web/api/auth/refresh" && init.method === "POST") {
      calls.post++; calls.csrf = init.headers?.["X-CSRF-Token"];
      if (how === "post") issue();
      if (how === "nocookie") return { ok: true, status: 200, text: async () => "{}", headers: { get: () => null } };
      if (how === "jsonbody") return { ok: true, status: 200, text: async () => "{}", headers: { get: () => null } };
      return { ok: how === "post", status: how === "post" ? 200 : 400, text: async () => "{}", headers: { get: () => null } };
    }
    return { ok: true, status: 200, text: async () => "", headers: { get: () => null } };
  };
  const ctx = { chrome, fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"), console: { warn() {}, log() {} }, setTimeout: (f) => setTimeout(f, 0), Date, Math, JSON, Promise, Map, Set, URL, parseInt, parseFloat, Number, String, Error, Object, Array, Infinity };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { webappToken, webappStatus, webappTokenMatch };", ctx);
  return { calls, api: ctx.__api };
}
const sender = { id: "ext", url: "http://localhost:3000/dashboard" };

(async () => {
  // 1) Gültiger Token (2 h) → unverändert zurück, keine Erneuerung, kein Refresh-Token in der Antwort
  const fresh2h = jwt(Date.now() + 2 * 3600e3);
  let e = makeEnv({ refresh_token_web: "R", access_token_web: fresh2h });
  let r = await e.api.webappToken(sender, false);
  assert.deepStrictEqual(Object.keys(r), ["accessToken"]); assert.strictEqual(r.accessToken, fresh2h);
  assert.strictEqual(e.calls.refresh, 0);

  // 2) Läuft in 10 min ab → Browser erneuert, neuer Token
  const soon = jwt(Date.now() + 10 * 60e3);
  e = makeEnv({ refresh_token_web: "R", access_token_web: soon });
  r = await e.api.webappToken(sender, false);
  assert.strictEqual(e.calls.refresh, 1); assert.notStrictEqual(r.accessToken, soon);

  // 3) fresh (Server hat abgelehnt) → alten Zugangs-Token entfernen, erneuern
  e = makeEnv({ refresh_token_web: "R", access_token_web: fresh2h });
  r = await e.api.webappToken(sender, true);
  assert.deepStrictEqual(e.calls.removed, ["access_token_web"]); assert.strictEqual(e.calls.refresh, 1); assert.ok(r.accessToken);

  // 3b) Früheres Verhalten: GET / setzt den Token schon → kein POST nötig
  e = makeEnv({ refresh_token_web: "R" }, "home");
  r = await e.api.webappToken(sender, false);
  assert.ok(r.accessToken); assert.strictEqual(e.calls.post, 0);

  // 3c) Seit 2026-10: GET / → /session-refresh ohne Cookies, erst der POST erneuert (mit CSRF aus der Seite)
  e = makeEnv({ refresh_token_web: "R" }, "post");
  r = await e.api.webappToken(sender, false);
  assert.ok(r.accessToken, "Token nach POST"); assert.strictEqual(e.calls.post, 1); assert.strictEqual(e.calls.csrf, "C1");

  // 3d) Angemeldet, aber Erneuerung scheitert → refresh-failed statt „nicht angemeldet“
  e = makeEnv({ refresh_token_web: "R" }, "fail");
  r = await e.api.webappToken(sender, false);
  assert.strictEqual(r.error, "refresh-failed");
  // Diagnose: Status-Codes und Ja/Nein, aber keine Token-Werte
  assert.strictEqual(r.diag.home, 200); assert.strictEqual(r.diag.post, 400); assert.strictEqual(r.diag.csrf, true);
  assert.ok(!JSON.stringify(r.diag).includes("R\""), "kein Refresh-Token in der Diagnose");
  assert.ok(!/eyJ|h\./.test(JSON.stringify(r.diag)), "kein Zugangs-Token in der Diagnose");

  // 3e) Hintergrund ohne Cookies, kein Tab offen → Tab im Hintergrund öffnen, dort erneuern, wieder schließen
  e = makeEnv({ refresh_token_web: "R" }, "nocookie", "none");
  r = await e.api.webappToken(sender, false);
  assert.ok(r.accessToken, "Token über neuen Tab");
  assert.strictEqual(e.calls.tabCreated, 1); assert.strictEqual(e.calls.tabRemoved, 1);

  // 3f) Hintergrund ohne Cookies, vinted.de-Tab offen → dort erneuern, nichts öffnen oder schließen
  e = makeEnv({ refresh_token_web: "R" }, "nocookie", "open");
  r = await e.api.webappToken(sender, false);
  assert.ok(r.accessToken, "Token über offenen Tab");
  assert.strictEqual(e.calls.tabCreated, 0); assert.strictEqual(e.calls.tabRemoved, 0); assert.strictEqual(e.calls.tabPost, 1);

  // 3g) Vinted liefert den Zugang im Antwort-Text (kein Cookie) → wird übernommen, Diagnose ohne Werte
  e = makeEnv({ refresh_token_web: "R" }, "jsonbody", "open");
  r = await e.api.webappToken(sender, false);
  assert.ok(r.accessToken && r.accessToken.startsWith("h."), "Token aus der Antwort");
  const st = await e.api.webappStatus(sender);
  assert.ok(st.lastRefresh.bodyToken === true);
  assert.ok(!JSON.stringify(st.lastRefresh).includes(r.accessToken), "kein Token-Wert in der Diagnose");

  // 3h) Zugangs-Cookie ist partitioniert → wird trotzdem gefunden, keine Erneuerung nötig
  e = makeEnv({ refresh_token_web: "R", "p:access_token_web": fresh2h }, "post", "open");
  r = await e.api.webappToken(sender, false);
  assert.strictEqual(r.accessToken, fresh2h); assert.strictEqual(e.calls.refresh, 0);

  // 4) Nicht angemeldet → not-logged-in, keine Erneuerung
  e = makeEnv({});
  r = await e.api.webappToken(sender, false);
  assert.strictEqual(r.error, "not-logged-in"); assert.strictEqual(e.calls.refresh, 0);

  // 5) Fremde Adresse → not-allowed
  e = makeEnv({ refresh_token_web: "R", access_token_web: fresh2h });
  r = await e.api.webappToken({ id: "ext", url: "https://evil.example/" }, false);
  assert.strictEqual(r.error, "not-allowed");

  // 6) Status ohne Token
  e = makeEnv({ refresh_token_web: "R", access_token_web: fresh2h });
  r = await e.api.webappStatus(sender);
  assert.strictEqual(r.version, "2.8.1"); assert.strictEqual(r.loggedIn, true); assert.ok(r.accessMin > 100);
  r = await makeEnv({}).api.webappStatus(sender);
  assert.strictEqual(r.loggedIn, false);

  // 7) Fingerabdruck-Vergleich: gleicher Token → match, anderer → kein match
  const sha = (t) => require("crypto").createHash("sha256").update(t).digest("hex");
  e = makeEnv({ refresh_token_web: "BROWSER-TOKEN", access_token_web: fresh2h });
  assert.strictEqual((await e.api.webappTokenMatch(sender, sha("BROWSER-TOKEN"))).match, true);
  assert.strictEqual((await e.api.webappTokenMatch(sender, sha("PRIVAT-TOKEN"))).match, false);
  assert.strictEqual((await e.api.webappTokenMatch({ id: "ext", url: "https://evil.example/" }, sha("BROWSER-TOKEN"))).error, "not-allowed");

  console.log("Web-App-Token-Tests bestanden.");
})().catch((err) => { console.error(err); process.exit(1); });
