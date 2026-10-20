// Simuliert background.js mit nachgebautem chrome-API und fetch.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");

function makeEnv(scenario) {
  const calls = { windowsCreate: 0, tabsCreate: 0, pageFetch: 0, refresh: 0, alarms: [], alarmsCleared: [], dnr: 0, fetches: [] };
  const session = {}, local = {};
  const area = (store) => ({
    get: async (k) => { const o = {}; [].concat(k).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; },
    set: async (o) => Object.assign(store, o), remove: async (k) => { [].concat(k).forEach((x) => delete store[x]); },
  });
  const ev = () => ({ addListener(fn) { this.fn = fn; } });
  let authed = scenario.authedFromStart;
  const json = (status, body, headers = {}) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: { get: (h) => headers[h] ?? null } });
  const html = (status, body) => ({ ok: status < 300, status, text: async () => body, headers: { get: () => null } });
  const fetch = async (url) => {
    calls.fetches.push(url);
    if (url === "https://www.vinted.de/") { calls.refresh++; authed = true; return html(200, '<meta name="csrf-token" content="TOK123">'); }
    if (scenario.blocked) return html(403, "<html>Just a moment... cf-challenge</html>");
    if (scenario.rateLimit) return json(429, { message: "slow" }, { "retry-after": "120" });
    if (!authed) return json(401, { message_code: "invalid_authentication_token" });
    if (url.includes("my_orders")) return json(200, { my_orders: [{ transaction_id: 1, title: "A", price: { amount: "5" }, status: "Bestellung abgeschlossen", date: "2026-10-01T10:00:00+02:00" }], pagination: { total_pages: 1 } });
    if (url.includes("/items")) return json(200, { items: [], pagination: { total_pages: 1 } });
    return json(200, {});
  };
  const chrome = {
    storage: { session: area(session), local: area(local) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => p },
    alarms: { get: async () => null, create: (n, o) => calls.alarms.push([n, o]), clear: (n) => { calls.alarmsCleared.push(n); }, onAlarm: ev() },
    declarativeNetRequest: { updateSessionRules: async () => { calls.dnr++; } },
    tabs: {
      TAB_ID_NONE: -1,
      query: async () => (scenario.openTab ? [{ id: 7, windowId: 1, status: "complete", url: "https://www.vinted.de/" }] : []),
      create: async () => { calls.tabsCreate++; return { id: 9 }; },
      update: async () => ({}),
    },
    windows: { create: async () => { calls.windowsCreate++; }, update: async () => ({}), remove: async () => {} },
    scripting: { executeScript: async () => { calls.pageFetch++; return [{ result: { ok: true, status: 200, json: { my_orders: [], items: [], pagination: { total_pages: 1 } } } }]; } },
    cookies: { get: async () => ({ value: "42" }) },
  };
  const ctx = { chrome, fetch, console: { warn() {}, log() {} }, setTimeout: (f) => setTimeout(f, 0), Date, Math, JSON, Promise, Map, Set, URL, parseInt, parseFloat, Number, String, Error, Object, Array, Infinity };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { runSync, autoSync, getSync };", ctx);
  return { ctx, calls, local, session, api: ctx.__api };
}

(async () => {
  // 1) Direkt, angemeldet
  let e = makeEnv({ authedFromStart: true });
  let r = await e.api.runSync("full", { interactive: false });
  assert.ok(r.ok, "direkt ok"); assert.strictEqual(r.sync.transport, "direct");
  assert.strictEqual(e.local.orders.length, 1);
  assert.strictEqual(e.calls.windowsCreate + e.calls.tabsCreate + e.calls.pageFetch, 0, "kein Fenster/Tab");
  // 2.9.0: kein eigener 10-min-Abgleich mehr – es wird kein Alarm angelegt, ein alter wird entfernt
  assert.strictEqual(e.calls.alarms.length, 0, "kein Alarm angelegt"); assert.deepStrictEqual(e.calls.alarmsCleared, ["vinted-sync"]);
  assert.ok(e.calls.dnr >= 1, "Header-Regel gesetzt");

  // 2) Login abgelaufen → Startseite unsichtbar → erneut
  e = makeEnv({ authedFromStart: false });
  r = await e.api.runSync("quick", { interactive: false });
  assert.ok(r.ok, "nach Refresh ok"); assert.strictEqual(e.calls.refresh, 1, "genau ein Refresh");
  assert.strictEqual(e.calls.windowsCreate + e.calls.tabsCreate, 0);

  // 3) Blockiert, aber offener Vinted-Tab → über den Tab, nichts geöffnet
  e = makeEnv({ authedFromStart: true, blocked: true, openTab: true });
  r = await e.api.runSync("quick", { interactive: false });
  assert.ok(r.ok); assert.strictEqual(r.sync.transport, "tab"); assert.ok(e.calls.pageFetch > 0);
  assert.strictEqual(e.calls.windowsCreate + e.calls.tabsCreate, 0);

  // 4) Blockiert, kein Tab, automatisch → Pause, nichts geöffnet
  e = makeEnv({ authedFromStart: true, blocked: true });
  r = await e.api.autoSync("alarm");
  assert.ok(!r.ok); assert.strictEqual(r.sync.paused, "challenge");
  assert.strictEqual(e.calls.windowsCreate + e.calls.tabsCreate, 0, "automatisch nie öffnen");
  r = await e.api.autoSync("dashboard");
  assert.strictEqual(r.skipped, "paused");

  // 5) Blockiert, kein Tab, nach Klick → genau ein normaler Tab, kein Fenster
  e = makeEnv({ authedFromStart: true, blocked: true });
  const realNow = Date.now; let t = realNow();
  e.ctx.Date.now = () => (t += 20000); // Zeit vorspulen, damit das 3-min-Warten endet
  r = await e.api.runSync("full", { interactive: true });
  e.ctx.Date.now = realNow;
  assert.strictEqual(e.calls.tabsCreate, 1, "ein Tab nach Klick"); assert.strictEqual(e.calls.windowsCreate, 0);

  // 6) 429 → Backoff
  e = makeEnv({ authedFromStart: true, rateLimit: true });
  r = await e.api.runSync("quick", { interactive: false });
  assert.strictEqual(r.sync.errorKind, "ratelimit"); assert.ok(r.sync.backoffUntil > Date.now());
  console.log("Hintergrund-Verbindungstests bestanden.");
})().catch((err) => { console.error(err); process.exit(1); });
