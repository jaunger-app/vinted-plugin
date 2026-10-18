// Senden für die Web-App (2.8.8): nur erlaubter Absender, nur wenn im Browser genau das erwartete Vinted-Konto
// angemeldet ist, Ergebnis sent/failed/unclear wie der Server der Web-App, nie ein zweiter Versuch.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");
const jwt = (sub) => "h." + Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".s";

// reply: Ergebnis des POST im Tab ({ ok, status, json } | "throw" | "hang")
// refreshWorks: POST /web/api/auth/refresh im Tab setzt einen frischen Zugangs-Token; apiUser: Antwort von /users/current
function makeEnv(jar, { tab = true, reply = { ok: true, status: 200, json: {} }, refreshWorks = false, apiUser = null } = {}) {
  const calls = { posts: [], refresh: 0, api: 0 };
  const ev = () => ({ addListener() {} });
  const area = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {} });
  const chrome = {
    storage: { session: area(), local: area() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { id: "ext", onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => p, getManifest: () => ({ version: "2.8.8" }) },
    alarms: { get: async () => null, create() {}, onAlarm: ev() },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { query: async () => (tab ? [{ id: 5, status: "complete", url: "https://www.vinted.de/" }] : []), get: async (id) => ({ id, status: "complete" }), create: async () => ({ id: 9 }), remove: async () => {} },
    scripting: { executeScript: async ({ args }) => {
      if (args[0] === "/web/api/auth/refresh") { calls.refresh++; if (refreshWorks) jar.access_token_web = jwt(100); return [{ result: { ok: refreshWorks, status: refreshWorks ? 200 : 401, json: {} } }]; }
      if (args[0] === "/api/v2/users/current") { calls.api++; return [{ result: apiUser ? { ok: true, status: 200, json: { user: { id: apiUser } } } : { ok: false, status: 401, json: null } }]; }
      calls.posts.push({ path: args[0], body: args[1]?.body });
      if (reply === "throw") throw new Error("Tab geschlossen");
      if (reply === "hang") return new Promise(() => {});
      return [{ result: reply }];
    } },
    cookies: {
      get: async ({ name }) => (jar[name] ? { value: jar[name] } : null),
      getAll: async ({ name, partitionKey }) => (partitionKey ? [] : jar[name] ? [{ name, value: jar[name], domain: ".vinted.de", path: "/" }] : []),
      remove: async () => {},
    },
  };
  const fetch = async () => ({ ok: true, status: 200, text: async () => "", headers: { get: () => null } });
  const fast = (f, ms) => setTimeout(f, Math.min(ms || 0, 20)); // Zeitgrenze im Test verkürzen
  const ctx = { chrome, fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"), console: { warn() {}, log() {} }, setTimeout: fast, Date, Math, JSON, Promise, Map, Set, URL, parseInt, parseFloat, Number, String, Error, Object, Array, Infinity };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { webappSend, classifySend };", ctx);
  return { calls, api: ctx.__api };
}
const sender = { id: "ext", url: "http://localhost:3000/dashboard/postfach" };
const jar = () => ({ refresh_token_web: "R", v_uid: "100", access_token_web: jwt(100) });
const msg = (o = {}) => ({ conv: "123", body: " Hallo ", expectUserId: "100", ...o });

(async () => {
  // 1) Richtiges Konto, Tab offen → gesendet, genau ein POST mit getrimmtem Text an die richtige Unterhaltung
  let e = makeEnv(jar());
  let r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.strictEqual(r.via, "tab");
  assert.strictEqual(e.calls.posts.length, 1);
  assert.strictEqual(e.calls.posts[0].path, "/api/v2/conversations/123/replies");
  assert.strictEqual(JSON.stringify(e.calls.posts[0].body), JSON.stringify({ reply: { body: "Hallo" } }));

  // 2) Anderes Vinted-Konto im Browser angemeldet → nichts gesendet
  e = makeEnv(jar());
  r = await e.api.webappSend(sender, msg({ expectUserId: "200" }));
  assert.deepStrictEqual([r.status, r.error], ["failed", "wrong-account"]); assert.strictEqual(e.calls.posts.length, 0);

  // 3) Ohne v_uid: Konto aus dem Zugangs-Token; ohne beides: nicht senden
  e = makeEnv({ refresh_token_web: "R", access_token_web: jwt(100) });
  assert.strictEqual((await e.api.webappSend(sender, msg())).status, "sent");
  e = makeEnv({ refresh_token_web: "R" });
  r = await e.api.webappSend(sender, msg());
  assert.deepStrictEqual([r.status, r.error], ["failed", "unknown-account"]); assert.strictEqual(e.calls.posts.length, 0);

  // 4) Nicht angemeldet, fremder Absender, ungültige Eingaben → nichts gesendet
  e = makeEnv({});
  assert.strictEqual((await e.api.webappSend(sender, msg())).error, "not-logged-in");
  e = makeEnv(jar());
  assert.strictEqual((await e.api.webappSend({ id: "ext", url: "https://evil.example/" }, msg())).error, "not-allowed");
  assert.strictEqual((await e.api.webappSend(sender, msg({ conv: "1/../x" }))).error, "bad-conversation");
  assert.strictEqual((await e.api.webappSend(sender, msg({ body: "  " }))).error, "bad-body");
  assert.strictEqual((await e.api.webappSend(sender, msg({ body: "x".repeat(4001) }))).error, "bad-body");
  assert.strictEqual(e.calls.posts.length, 0);

  // 5) Einordnung: 4xx = fehlgeschlagen, 5xx/Abbruch/Zeitüberschreitung/Tab weg = unklar – immer nur ein POST
  e = makeEnv(jar(), { reply: { ok: false, status: 400, json: { message: "Login erforderlich" } } });
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "failed"); assert.match(r.error, /Login erforderlich/);
  for (const reply of [{ ok: false, status: 502, json: null }, { ok: false, status: 0, error: "net" }, "throw", "hang"]) {
    e = makeEnv(jar(), { reply });
    r = await e.api.webappSend(sender, msg());
    assert.strictEqual(r.status, "unclear", JSON.stringify(reply));
    assert.strictEqual(e.calls.posts.length, 1);
  }
  // 6) Zugang im Browser abgelaufen, kein v_uid: erst erneuern (im Tab), dann Konto aus dem frischen Token
  e = makeEnv({ refresh_token_web: "R" }, { refreshWorks: true });
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.ok(e.calls.refresh >= 1); assert.strictEqual(e.calls.posts.length, 1);

  // 7) Erneuern klappt nicht: Konto aus dem Refresh-Token (JWT), sonst aus /users/current im Tab
  e = makeEnv({ refresh_token_web: jwt(100) });
  assert.strictEqual((await e.api.webappSend(sender, msg())).status, "sent");
  e = makeEnv({ refresh_token_web: "R" }, { apiUser: 100 });
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.strictEqual(e.calls.api, 1);
  e = makeEnv({ refresh_token_web: "R" }, { apiUser: 200 });
  assert.strictEqual((await e.api.webappSend(sender, msg())).error, "wrong-account");
  assert.strictEqual(e.calls.posts.length, 0);

  console.log("test-webapp-send: ok");
})().catch((err) => { console.error(err); process.exit(1); });
