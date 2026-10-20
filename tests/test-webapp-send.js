// Senden für die Web-App (2.8.8, 2.9.3 Messaging-Dienst): nur erlaubter Absender, nur wenn im Browser genau das erwartete
// Vinted-Konto angemeldet ist, nur an eine per GET bestätigte UUID, Ergebnis sent/failed/unclear, nie ein zweiter Versuch.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");
const jwt = (sub) => "h." + Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".s";

const UUID = "01a149d2-15d2-78f7-9f9c-778288936057";
const OTHER = "01a149d2-0000-7000-8000-000000000000";
const MSG = "https://api.vinted.de/messaging/main/conversations/";
// reply: Ergebnis des POST im Tab ({ ok, status, json } | "throw" | "hang")
// refreshWorks: POST /web/api/auth/refresh im Tab setzt einen frischen Zugangs-Token; apiUser: Antwort von /users/current
// convs: Unterhaltungen im Messaging-Dienst (uuid → { core, allow_reply }); pages: Seiten der Liste messaging/main/inbox
// als [[uuid, gegenüber], …]; Gegenüber der Test-Unterhaltung ist "7"
const INBOX = "https://api.vinted.de/messaging/main/inbox";
function makeEnv(jar, { tab = true, reply = { ok: true, status: 201, json: {} }, refreshWorks = false, apiUser = null,
  convs = { [UUID]: { core: 123 } }, pages = [[[UUID, "7"]]] } = {}) {
  const calls = { posts: [], refresh: 0, api: 0, gets: [], scans: 0 };
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
      if (String(args[0]).startsWith(INBOX)) {
        const cur = new URL(args[0]).searchParams.get("next_cursor"); const i = cur ? Number(cur) : 0; calls.scans++;
        const list = (pages[i] || []).map(([id, other]) => ({ id, opposite_users: [{ type: "member", data: { id: other } }] }));
        return [{ result: { ok: true, status: 200, json: { conversations: list, pagination: { has_next: i + 1 < pages.length, next_cursor: String(i + 1) } } } }];
      }
      if (String(args[0]).startsWith(MSG) && !args[1]) {
        const id = decodeURIComponent(args[0].slice(MSG.length)); calls.gets.push(id);
        const c = convs[id];
        return [{ result: c ? { ok: true, status: 200, json: { id, core_id_deprecated: c.core, allow_reply: c.allow_reply ?? true } } : { ok: false, status: 404, json: null } }];
      }
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
  const fast = (f, ms) => setTimeout(f, (ms || 0) >= 10000 ? 150 : 1); // Zeitgrenzen und Pausen im Test verkürzen
  const ctx = { chrome, fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"), console: { warn() {}, log() {} }, setTimeout: fast, Date, Math, JSON, Promise, Map, Set, URL, parseInt, parseFloat, Number, String, Error, Object, Array, Infinity };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { webappSend, classifySend, convUuids };", ctx);
  return { calls, api: ctx.__api };
}
const sender = { id: "ext", url: "http://localhost:3000/dashboard/postfach" };
const jar = () => ({ refresh_token_web: "R", v_uid: "100", access_token_web: jwt(100) });
const msg = (o = {}) => ({ conv: "123", body: " Hallo ", expectUserId: "100", otherUserId: "7", ...o });

(async () => {
  // 1) Richtiges Konto, Tab offen → gesendet, genau ein POST mit getrimmtem Text an die richtige Unterhaltung
  let e = makeEnv(jar());
  let r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.strictEqual(r.via, "tab");
  assert.strictEqual(e.calls.posts.length, 1);
  assert.strictEqual(e.calls.posts[0].path, `${MSG}${UUID}/replies`);
  assert.strictEqual(JSON.stringify(e.calls.posts[0].body), JSON.stringify({ content: "Hallo", is_personal_data_sharing_check_skipped: false, photo_temp_uuids: null }));
  assert.deepStrictEqual(e.calls.gets, [UUID]);
  // gemerkte UUID: beim zweiten Senden keine Liste mehr, aber wieder geprüft
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.strictEqual(e.calls.scans, 1); assert.strictEqual(e.calls.posts.length, 2);

  // 1b) UUID gehört zu einer anderen Unterhaltung (core_id_deprecated passt nicht) ⇒ nicht gesendet; die nächste passt
  e = makeEnv(jar(), { convs: { [OTHER]: { core: 999 } }, pages: [[[OTHER, "7"]]] });
  r = await e.api.webappSend(sender, msg());
  assert.deepStrictEqual([r.status, r.error], ["failed", "conversation-not-found"]); assert.strictEqual(e.calls.posts.length, 0);
  assert.deepStrictEqual([r.diag.pages, r.diag.entries, r.diag.candidates, r.diag.checks], [1, 1, 1, 1]);
  // zwei Unterhaltungen mit demselben Gegenüber: die passende (core_id_deprecated) wird genommen
  e = makeEnv(jar(), { convs: { [OTHER]: { core: 999 }, [UUID]: { core: 123 } }, pages: [[[OTHER, "7"], [UUID, "7"]]] });
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.strictEqual(e.calls.posts[0].path, `${MSG}${UUID}/replies`);
  // Vorauswahl übers Gegenüber: fremde Unterhaltungen werden gar nicht erst geprüft; Treffer erst auf Seite 3 (Cursor)
  e = makeEnv(jar(), { convs: { [OTHER]: { core: 123 }, [UUID]: { core: 123 } }, pages: [[[OTHER, "8"]], [], [[UUID, "7"]]] });
  r = await e.api.webappSend(sender, msg());
  assert.strictEqual(r.status, "sent"); assert.deepStrictEqual(e.calls.gets, [UUID]); assert.strictEqual(e.calls.scans, 3);
  // ohne bekanntes Gegenüber: der Reihe nach prüfen, höchstens 6 Detailanfragen
  const many = Array.from({ length: 10 }, (_, i) => [`01a149d2-0000-7000-8000-00000000000${i}`, "9"]);
  e = makeEnv(jar(), { convs: Object.fromEntries(many.map(([id]) => [id, { core: 1 }])), pages: [many] });
  r = await e.api.webappSend(sender, msg({ otherUserId: "" }));
  assert.strictEqual(r.error, "conversation-not-found"); assert.strictEqual(e.calls.gets.length, 6); assert.strictEqual(e.calls.posts.length, 0);
  // leere Liste ⇒ nicht gesendet
  e = makeEnv(jar(), { pages: [[]] });
  assert.strictEqual((await e.api.webappSend(sender, msg())).error, "conversation-not-found"); assert.strictEqual(e.calls.posts.length, 0);
  // Antworten nicht erlaubt ⇒ nicht gesendet
  e = makeEnv(jar(), { convs: { [UUID]: { core: 123, allow_reply: false } } });
  assert.strictEqual((await e.api.webappSend(sender, msg())).error, "reply-not-allowed"); assert.strictEqual(e.calls.posts.length, 0);
  // Web-App schickt direkt die UUID ⇒ ohne Suche, nach GET-Prüfung
  e = makeEnv(jar());
  r = await e.api.webappSend(sender, msg({ conv: UUID }));
  assert.strictEqual(r.status, "sent"); assert.strictEqual(e.calls.scans, 0);
  // kein vinted.de-Tab ⇒ nicht gesendet (der Messaging-Dienst geht nur aus der Seite)
  e = makeEnv(jar(), { tab: false });
  assert.strictEqual((await e.api.webappSend(sender, msg())).error, "no-tab"); assert.strictEqual(e.calls.posts.length, 0);

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
