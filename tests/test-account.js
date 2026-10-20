// 2.9.0: Konto der Erweiterung (account.js) – mit nachgebautem chrome.storage und fetch.
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "account.js"), "utf8");

function makeEnv(handler) {
  const local = {}, session = {}, calls = [];
  const area = (store) => ({
    get: async (k) => (typeof k === "string" ? { [k]: store[k] } : { ...store }),
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { delete store[k]; },
  });
  const ctx = {
    chrome: { storage: { local: area(local), session: area(session) } },
    AbortSignal, URL, JSON, Date, Promise, Error, console,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization || null, credentials: init.credentials });
      const r = await handler(url, init, calls.length);
      if (r === "network") throw new TypeError("Failed to fetch");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { login, logout, idToken, authedRequest, currentUser, requestPasswordReset, setBase, getBase, AccountError };", ctx);
  return { api: ctx.__api, local, session, calls };
}
const session = (n, exp = Date.now() + 3600e3) => ({ ok: true, idToken: `ID${n}`, refreshToken: `RT${n}`, expiresAt: exp, user: { uid: "u1", email: "a@b.de" } });

(async () => {
  // 1) Anmelden speichert Refresh-Token (local) und ID-Token (session), nie das Passwort; ohne Cookies
  let e = makeEnv((url) => (url.endsWith("/api/extension/login") ? { status: 200, json: session(1) } : { status: 200, json: { ok: true, user: { uid: "u1", email: "a@b.de" } } }));
  const user = await e.api.login(" a@b.de ", "geheim");
  assert.strictEqual(user.email, "a@b.de");
  assert.strictEqual(e.calls[0].url, "http://localhost:3000/api/extension/login");
  assert.strictEqual(e.calls[0].credentials, "omit");
  assert.strictEqual(e.local.extAuth.refreshToken, "RT1");
  assert.strictEqual(e.session.extIdToken.idToken, "ID1");
  assert.ok(!JSON.stringify(e.local).includes("geheim") && !JSON.stringify(e.session).includes("geheim"), "Passwort nie gespeichert");
  // Sitzung wird serverseitig geprüft (nicht nur lokal vertraut)
  const me = await e.api.currentUser();
  assert.strictEqual(me.uid, "u1");
  assert.strictEqual(e.calls[1].url, "http://localhost:3000/api/extension/me");
  assert.strictEqual(e.calls[1].auth, "Bearer ID1");

  // 2) Falsche Zugangsdaten → verständlicher Fehler, nichts gespeichert
  e = makeEnv(() => ({ status: 401, json: { ok: false, error: "E-Mail oder Passwort ist falsch." } }));
  await assert.rejects(e.api.login("a@b.de", "x"), (err) => err.kind === "credentials" && /falsch/.test(err.message));
  assert.strictEqual(e.local.extAuth, undefined);
  await assert.rejects(e.api.login("", ""), (err) => err.kind === "input");

  // 3) ID-Token kurz vor Ablauf → wird über /refresh erneuert
  e = makeEnv((url) => (url.endsWith("/refresh") ? { status: 200, json: session(2) } : { status: 200, json: session(1, Date.now() + 30e3) }));
  await e.api.login("a@b.de", "pw");
  const tok = await e.api.idToken();
  assert.strictEqual(tok, "ID2");
  assert.deepStrictEqual(e.calls[1].body, { refreshToken: "RT1" });
  assert.strictEqual(e.local.extAuth.refreshToken, "RT2");

  // 4) 401 bei einem Aufruf → einmal mit frischem Token wiederholen
  e = makeEnv((url, init, n) => {
    if (url.endsWith("/login")) return { status: 200, json: session(1) };
    if (url.endsWith("/refresh")) return { status: 200, json: session(2) };
    return init.headers.authorization === "Bearer ID1" ? { status: 401, json: { ok: false, error: "abgelaufen" } } : { status: 200, json: { ok: true, accounts: [] } };
  });
  await e.api.login("a@b.de", "pw");
  const r = await e.api.authedRequest("/api/vinted/accounts");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, accounts: [] });

  // 5) Refresh abgelehnt (abgelaufen/widerrufen) → abmelden, „Sitzung abgelaufen“
  e = makeEnv((url) => (url.endsWith("/login") ? { status: 200, json: session(1, Date.now() - 1) } : { status: 401, json: { ok: false, error: "Sitzung abgelaufen – bitte neu anmelden." } }));
  await e.api.login("a@b.de", "pw");
  await assert.rejects(e.api.currentUser(), (err) => err.kind === "expired" && /abgelaufen/.test(err.message));
  assert.strictEqual(e.local.extAuth, undefined, "lokale Sitzung gelöscht");
  assert.strictEqual(await e.api.currentUser(), null, "danach abgemeldet");

  // 6) Netzwerkfehler → eigener Fehler, Sitzung bleibt
  e = makeEnv((url) => (url.endsWith("/login") ? { status: 200, json: session(1) } : "network"));
  await e.api.login("a@b.de", "pw");
  await assert.rejects(e.api.currentUser(), (err) => err.kind === "network" && /Keine Verbindung zu localhost:3000/.test(err.message));
  assert.ok(e.local.extAuth, "Sitzung bleibt bei Netzwerkfehler");

  // 7) Abmelden löscht beides
  await e.api.logout();
  assert.strictEqual(e.local.extAuth, undefined); assert.strictEqual(e.session.extIdToken, undefined);

  // 8) Server-Adresse: nur erlaubte; Wechsel ⇒ alte Sitzung gilt nicht
  e = makeEnv(() => ({ status: 200, json: session(1) }));
  await e.api.login("a@b.de", "pw");
  await assert.rejects(e.api.setBase("https://boese.example"), (err) => err.kind === "input");
  await e.api.setBase("https://jucreative.de");
  assert.strictEqual(await e.api.currentUser(), null, "Sitzung gehört zur alten Adresse");

  // 9) Passwort zurücksetzen braucht eine E-Mail
  await assert.rejects(e.api.requestPasswordReset(""), (err) => err.kind === "input");
  await e.api.requestPasswordReset("a@b.de");
  assert.ok(e.calls.at(-1).url.endsWith("/api/extension/password-reset"));

  console.log("Konto-Tests bestanden.");
})().catch((err) => { console.error(err); process.exit(1); });
