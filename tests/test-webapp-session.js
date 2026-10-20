// 2.9.1: Anmeldung von der Website übernehmen (webappSession) – Absender, Form und Server-Bestätigung.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");

function makeEnv(meReply) {
  const local = {}, session = {}, fetches = [];
  const ev = () => ({ addListener() {} });
  const area = (store) => ({ get: async (k) => (typeof k === "string" ? { [k]: store[k] } : { ...store }), set: async (o) => { Object.assign(store, o); }, remove: async (k) => { delete store[k]; } });
  const chrome = {
    storage: { session: area(session), local: area(local) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { id: "ext", onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => p, getManifest: () => ({ version: "2.9.1" }) },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { TAB_ID_NONE: -1 },
    cookies: { get: async () => null, getAll: async () => [], remove: async () => {} },
  };
  const fetch = async (url, init) => {
    fetches.push({ url, auth: init?.headers?.authorization });
    const r = meReply(url, init);
    return { ok: r.status === 200, status: r.status, json: async () => r.json };
  };
  const ctx = vm.createContext({ chrome, fetch, console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, crypto: globalThis.crypto, AbortSignal, Promise, Date, JSON, Math, Number });
  vm.runInContext(src + "\n;globalThis.__api = { webappSession };", ctx);
  return { api: ctx.__api, local, session, fetches };
}
const web = { id: "ext", url: "http://localhost:3000/erweiterung-verbinden" };
const sess = { idToken: "EXT-ID", refreshToken: "EXT-RT", expiresAt: Date.now() + 3600e3, user: { uid: "u1", email: "a@b.de" } };
const okMe = () => ({ status: 200, json: { ok: true, extension: true, user: { uid: "u1", email: "a@b.de" } } });

(async () => {
  // fremder Absender (andere Seite / andere Erweiterung) → abgelehnt, nichts gespeichert, kein Netz
  let e = makeEnv(okMe);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await e.api.webappSession({ id: "ext", url: "https://boese.example/x" }, sess))), { error: "not-allowed" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await e.api.webappSession({ id: "andere", url: web.url }, sess))), { error: "not-allowed" });
  assert.strictEqual(e.fetches.length, 0); assert.strictEqual(e.local.extAuth, undefined);

  // kaputte Form → abgelehnt
  assert.strictEqual((await e.api.webappSession(web, { idToken: 1 })).error, "invalid");
  assert.strictEqual((await e.api.webappSession(web, null)).error, "invalid");

  // Server bestätigt nicht (kein ext-Token / anderes Konto / 401) → nichts gespeichert
  for (const bad of [
    () => ({ status: 200, json: { ok: true, extension: false, user: { uid: "u1" } } }),
    () => ({ status: 200, json: { ok: true, extension: true, user: { uid: "fremd" } } }),
    () => ({ status: 401, json: { ok: false } }),
  ]) {
    e = makeEnv(bad);
    assert.strictEqual((await e.api.webappSession(web, sess)).error, "rejected");
    assert.strictEqual(e.local.extAuth, undefined);
  }

  // bestätigt → gespeichert, für genau diese Server-Adresse; Prüfung beim Server mit dem übergebenen Token
  e = makeEnv(okMe);
  const r = await e.api.webappSession(web, sess);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.email, "a@b.de");
  assert.strictEqual(e.fetches[0].url, "http://localhost:3000/api/extension/me");
  assert.strictEqual(e.fetches[0].auth, "Bearer EXT-ID");
  assert.strictEqual(e.local.extAuth.refreshToken, "EXT-RT"); assert.strictEqual(e.local.extAuth.base, "http://localhost:3000");
  assert.strictEqual(e.local.webBase, "http://localhost:3000");
  assert.strictEqual(e.session.extIdToken.idToken, "EXT-ID");

  // www.jucreative.de wird auf die Server-Adresse jucreative.de abgebildet
  e = makeEnv(okMe);
  await e.api.webappSession({ id: "ext", url: "https://www.jucreative.de/erweiterung-verbinden" }, sess);
  assert.strictEqual(e.fetches[0].url, "https://jucreative.de/api/extension/me");
  assert.strictEqual(e.local.extAuth.base, "https://jucreative.de");

  console.log("Übergabe-Tests bestanden.");
})().catch((err) => { console.error(err); process.exit(1); });
