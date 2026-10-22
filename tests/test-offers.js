// Angebote für die Web-App (2.9.5, 055). Geprüft wird mit nachgebauten Vinted-Antworten (Aufbau von /api/v2/conversations
// wie in der Web-App seit 040 gelesen, Angebotsfelder laut Vinted-Code bzw. vinted-cli/Velo – keine echten Daten):
// - gesperrte Aktionen gehen nie ans Netz, lesende Aktionen liefern nur Zahlen/Status ohne Namen oder Texte
// - bindende Aktionen (im Test freigeschaltet) nur für den Verkäufer auf ein offenes Angebot des Gegenübers mit
//   unverändertem Preis, genau ein Aufruf mit dem belegten Body, danach Abgleich mit dem neu geladenen Stand
// - Doppelschutz (requestKey, eine Aktion je Unterhaltung), unklare Ergebnisse nie wiederholt
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");
const jwt = (sub) => "h." + Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".s";

const CONV = "https://www.vinted.de/api/v2/conversations/123";
const TX = "https://www.vinted.de/api/v2/transactions/777";
const request = (o = {}) => ({ entity_type: "offer_request_message", created_at_ts: "2026-10-21T10:00:00+02:00", entity: {
  offer_request_id: 555, transaction_id: 777, user_id: 7, status: 10, status_title: "Ausstehend", price: { amount: "18.0", currency_code: "EUR" },
  original_price: { amount: "25.0", currency_code: "EUR" }, current: true, price_fixed: false, login: "anna_m", body: "Hallo, ich bin Anna", ...o } });
const myOffer = (o = {}) => ({ entity_type: "offer_message", created_at_ts: "2026-10-21T10:05:00+02:00", entity: {
  id: 901, transaction_id: 777, user_id: 100, status: 10, price: { amount: "21.5", currency_code: "EUR" }, current: true, ...o } });
const text = { entity_type: "message", created_at_ts: "2026-10-21T09:50:00+02:00", entity: { id: 1, body: "Ist die Jeans noch da?", user_id: 7 } };
const detail = (messages, tx = {}) => ({ conversation: { id: 123, allow_reply: true, opposite_user: { id: 7, login: "anna_m" },
  transaction: { id: 777, item_id: 42, user_side: "seller", ...tx }, messages } });

/**
 * details: Folge der GET-Antworten für die Unterhaltung (die letzte wiederholt sich) – z. B. [vorher, nachher].
 * reply: Antwort auf den schreibenden Aufruf ({ ok, status, json, text } | "throw" | Promise).
 */
function makeEnv({ details = [detail([text, request()])], reply = { ok: true, status: 200, json: {} }, options = null } = {}) {
  const jar = { refresh_token_web: "R", v_uid: "100", access_token_web: jwt(100) };
  const calls = { writes: [], gets: [], scripts: 0 };
  const queue = [...details];
  const ev = () => ({ addListener() {} });
  const session = {};
  const chrome = {
    storage: { session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, o), remove: async () => {} }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { id: "ext", onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => p, getManifest: () => ({ version: "2.9.5" }) },
    alarms: { get: async () => null, create() {}, onAlarm: ev() },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { query: async () => [{ id: 5, status: "complete", url: "https://www.vinted.de/" }], get: async (id) => ({ id, status: "complete" }), create: async () => ({ id: 9 }), remove: async () => {} },
    scripting: { executeScript: async ({ args }) => {
      calls.scripts++;
      const url = String(args[0]), opt = args[1];
      if (url === CONV && !opt) { calls.gets.push(url); const d = queue.length > 1 ? queue.shift() : queue[0]; return [{ result: d === 404 ? { ok: false, status: 404, json: null } : { ok: true, status: 200, json: d } }]; }
      if (url.endsWith("/seller_options") && !opt) return [{ result: options || { ok: true, status: 200, json: { seller_options: { min_price: { amount: "5.0", currency_code: "EUR" }, max_price: { amount: "25.0", currency_code: "EUR" } }, buyer: { login: "anna_m", photo: { url: "https://x" } } } } }];
      calls.writes.push({ url, method: opt && opt.method, body: opt ? opt.body : undefined });
      if (reply === "throw") throw new Error("Tab geschlossen");
      if (reply && typeof reply.then === "function") return [{ result: await reply }];
      return [{ result: reply }];
    } },
    cookies: {
      get: async ({ name }) => (jar[name] ? { value: jar[name] } : null),
      getAll: async ({ name, partitionKey }) => (partitionKey ? [] : jar[name] ? [{ name, value: jar[name], domain: ".vinted.de", path: "/" }] : []),
      remove: async () => {},
    },
  };
  const fetch = async () => ({ ok: true, status: 200, text: async () => "", headers: { get: () => null } });
  const fast = (f, ms) => setTimeout(f, (ms || 0) >= 10000 ? 150 : 1);
  const ctx = { chrome, fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"), console: { warn() {}, log() {} }, setTimeout: fast, Date, Math, JSON, Promise, Map, Set, URL, RegExp, parseInt, parseFloat, Number, String, Error, Object, Array, Infinity, isNaN };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__api = { webappOffer, webappStatus, OFFER_ENDPOINTS, offerCaps, extractDeal };", ctx);
  return { calls, api: ctx.__api };
}
const sender = { id: "ext", url: "http://localhost:3000/dashboard/postfach" };
let keyN = 0;
const key = () => `test-key-${++keyN}-0000`;
const msg = (o = {}) => ({ conv: "123", expectUserId: "100", requestKey: key(), ...o });
/** Nur im Test freischalten – im echten Code erst nach ausdrücklicher Zustimmung des Nutzers (FREISCHALTEN (055)). */
const enable = (api, ...actions) => { for (const a of actions) api.OFFER_ENDPOINTS[a].enabled = true; };
const BINDING = ["counter", "offer", "reject", "accept"];

(async () => {
  // 1) Auslieferung (vom Nutzer am 2026-10-22 freigegeben): alles an. Abgeschaltet (Not-Aus) ⇒ not-enabled ohne einen
  //    einzigen Aufruf im Tab.
  let e = makeEnv();
  assert.deepStrictEqual([...e.api.offerCaps()], ["state", "options", "estimate", "counter", "offer", "reject", "accept"]);
  for (const a of BINDING) e.api.OFFER_ENDPOINTS[a].enabled = false;
  for (const action of BINDING) {
    const r = await e.api.webappOffer(sender, msg({ action, offerRequestId: "555", expectedPrice: "18", price: "21" }));
    assert.deepStrictEqual([r.status, r.error], ["failed", "not-enabled"], action);
  }
  assert.strictEqual(e.calls.scripts, 0);
  const st = await e.api.webappStatus(sender);
  assert.deepStrictEqual([...st.offerCaps], ["state", "options", "estimate"]);

  // 2) state: Unterhaltung über /api/v2/conversations, Angebot offen (Status 10), Verkäufer, keine Namen/Texte
  let r = await e.api.webappOffer(sender, msg({ action: "state" }));
  assert.strictEqual(r.status, "ok");
  assert.deepStrictEqual([r.transactionId, [...r.itemIds], r.seller, r.currency, r.allowReply], ["777", ["42"], true, "EUR", true]);
  assert.strictEqual(r.offers.length, 1);
  const o = r.offers[0];
  assert.deepStrictEqual([o.kind, o.offerRequestId, o.status, o.state, o.current, o.mine, o.price.amount, o.originalPrice.amount], ["offer_request", "555", "10", "pending", true, false, "18.0", "25.0"]);
  assert.ok(!/anna|Anna|Jeans/.test(JSON.stringify(r)), "kein Name/Text im Auszug");
  assert.deepStrictEqual(e.calls.gets, [CONV]); assert.strictEqual(e.calls.writes.length, 0);
  // Rolle aus seller_id, sonst aus einer Preisanfrage des Gegenübers; Käufer bleibt Käufer
  assert.strictEqual(e.api.extractDeal(detail([request()], { user_side: undefined, seller_id: 100 }), "100").seller, true);
  assert.strictEqual(e.api.extractDeal(detail([request()], { user_side: undefined }), "100").seller, true);
  assert.strictEqual(e.api.extractDeal(detail([text], { user_side: undefined }), "100").seller, null);
  assert.strictEqual(e.api.extractDeal(detail([request()], { user_side: "buyer" }), "100").seller, false);
  assert.strictEqual(e.api.extractDeal(detail([request()], { user_side: undefined, current_user_side: "seller" }), "100").seller, true);
  // Aufbau des Messaging-Dienstes wird auch verstanden; Preis als Text mit Währung daneben ebenso
  const legacy = e.api.extractDeal({ conversation: { id: 123, messages: [{ message_type: "legacy_offer_request", data: { entity: { offer_request_id: 9, status: 10, price: "12.0", currency: "EUR", user_id: 7, current: true } } }] } }, "100");
  assert.deepStrictEqual([legacy.offers[0].offerRequestId, legacy.offers[0].price.amount, legacy.offers[0].price.currency, legacy.offers[0].state], ["9", "12.0", "EUR", "pending"]);
  // Angebotsnachricht ohne lesbaren Inhalt ⇒ Typ-Zählung als Hinweis (nur Typen, keine Inhalte)
  e = makeEnv({ details: [{ conversation: { id: 123, messages: [{ entity_type: "offer_request_message", entity: "kaputt" }] } }] });
  r = await e.api.webappOffer(sender, msg({ action: "state" }));
  assert.deepStrictEqual([r.offers.length, r.offers[0].offerRequestId, r.offers[0].state], [1, null, "unknown"]);
  e = makeEnv({ details: [{ conversation: { id: 123, messages: [{ entity_type: "offer_request_v3", payload: {} }] } }] });
  r = await e.api.webappOffer(sender, msg({ action: "state" }));
  assert.ok(r.offers.length === 1 && r.offers[0].offerRequestId === null);
  // fremde Unterhaltung (andere id) bzw. 404 ⇒ nicht gefunden
  e = makeEnv({ details: [{ conversation: { id: 999, messages: [] } }] });
  assert.strictEqual((await e.api.webappOffer(sender, msg({ action: "state" }))).error, "conversation-not-found");
  e = makeEnv({ details: [404] });
  assert.strictEqual((await e.api.webappOffer(sender, msg({ action: "state" }))).error, "conversation-not-found");

  // 3) options (lesend): nur Zahlen/Codes; estimate: Body genau wie Vinteds Website-Code
  e = makeEnv();
  r = await e.api.webappOffer(sender, msg({ action: "options", transactionId: "777" }));
  assert.strictEqual(r.status, "ok"); assert.strictEqual(r.data.seller_options.min_price.amount, "5.0");
  assert.ok(!/anna|https/.test(JSON.stringify(r)));
  assert.strictEqual((await e.api.webappOffer(sender, msg({ action: "options" }))).error, "no-transaction");
  e = makeEnv({ reply: { ok: true, status: 200, json: { total_price: { amount: "23.4", currency_code: "EUR" } } } });
  r = await e.api.webappOffer(sender, msg({ action: "estimate", transactionId: "777", itemIds: ["42"], currency: "EUR", price: "21.50" }));
  assert.strictEqual(r.status, "ok"); assert.strictEqual(r.data.total_price.amount, "23.4");
  assert.deepStrictEqual([e.calls.writes[0].url, e.calls.writes[0].method, JSON.stringify(e.calls.writes[0].body)],
    ["https://www.vinted.de/api/v2/offer/estimate_with_fees", "POST", '{"item_ids":[42],"offer_price":{"amount":"21.50","currency_code":"EUR"},"fees":["buyer_protection"]}']);
  assert.strictEqual((await e.api.webappOffer(sender, msg({ action: "estimate", transactionId: "777", price: "21" }))).error, "no-item");

  // 4) Freigeschaltet: Gegenangebot ⇒ genau ein POST mit belegtem Body, Abgleich findet das neue eigene Angebot
  e = makeEnv({ details: [detail([text, request()]), detail([text, request(), myOffer()])] });
  enable(e.api, ...BINDING);
  r = await e.api.webappOffer(sender, msg({ action: "counter", offerRequestId: "555", expectedPrice: "18", price: "21.5" }));
  assert.deepStrictEqual([r.status, r.afterCheck], ["confirmed", "ok"]);
  assert.deepStrictEqual([e.calls.writes.length, e.calls.writes[0].url, e.calls.writes[0].method, JSON.stringify(e.calls.writes[0].body)],
    [1, `${TX}/offers`, "POST", '{"offer":{"price":"21.50","currency":"EUR"}}']);
  assert.strictEqual(r.after.offers.length, 2);
  // eigenes Preisangebot ohne Anfrage (Plus-Menü)
  e = makeEnv({ details: [detail([text]), detail([text, myOffer({ price: { amount: "20.0", currency_code: "EUR" } })])] });
  enable(e.api, ...BINDING);
  r = await e.api.webappOffer(sender, msg({ action: "offer", price: "20" }));
  assert.deepStrictEqual([r.status, r.afterCheck, JSON.stringify(e.calls.writes[0].body)], ["confirmed", "ok", '{"offer":{"price":"20.00","currency":"EUR"}}']);
  // Annehmen / Ablehnen ⇒ PUT ohne Body, Abgleich am neuen Status
  for (const [action, after] of [["accept", 20], ["reject", 30]]) {
    e = makeEnv({ details: [detail([request()]), detail([request({ status: after, current: false })])] });
    enable(e.api, ...BINDING);
    r = await e.api.webappOffer(sender, msg({ action, offerRequestId: "555", expectedPrice: "18.00" }));
    assert.deepStrictEqual([r.status, r.afterCheck], ["confirmed", "ok"], action);
    assert.deepStrictEqual([e.calls.writes.length, e.calls.writes[0].url, e.calls.writes[0].method, e.calls.writes[0].body], [1, `${TX}/offer_requests/555/${action}`, "PUT", undefined], action);
  }
  // Annehmen bestätigt, aber Stand zeigt etwas anderes ⇒ Hinweis statt stillem Erfolg
  e = makeEnv({ details: [detail([request()]), detail([request({ status: 40, current: false })])] });
  enable(e.api, "accept");
  r = await e.api.webappOffer(sender, msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" }));
  assert.deepStrictEqual([r.status, r.afterCheck], ["confirmed", "other"]);
  // Gegenangebot bestätigt, neues Angebot mit anderem Preis ⇒ price-mismatch
  e = makeEnv({ details: [detail([request()]), detail([request(), myOffer({ price: { amount: "2150.0", currency_code: "EUR" } })])] });
  enable(e.api, "counter");
  r = await e.api.webappOffer(sender, msg({ action: "counter", offerRequestId: "555", expectedPrice: "18", price: "21.50" }));
  assert.deepStrictEqual([r.status, r.afterCheck], ["confirmed", "price-mismatch"]);

  // 5) Schutzprüfungen ⇒ nie ein schreibender Aufruf
  const guards = [
    [[request({ price: { amount: "15.0", currency_code: "EUR" } })], {}, "price-changed"],
    [[request({ status: 20 })], {}, "offer-not-open"],
    [[request({ status: 40 })], {}, "offer-not-open"],
    [[request({ status: 99 })], {}, "offer-not-open"],
    [[request({ current: false })], {}, "offer-not-open"],
    [[request({ user_id: 100 })], { user_side: "seller" }, "offer-is-mine"],
    [[request()], { user_side: "buyer" }, "not-seller"],
  ];
  for (const [messages, tx, err] of guards) {
    e = makeEnv({ details: [detail(messages, tx)] }); enable(e.api, ...BINDING);
    r = await e.api.webappOffer(sender, msg({ action: "reject", offerRequestId: "555", expectedPrice: "18" }));
    assert.deepStrictEqual([r.status, r.error], ["failed", err], err); assert.strictEqual(e.calls.writes.length, 0, err);
  }
  e = makeEnv(); enable(e.api, ...BINDING);
  const noWrite = async (m, err) => { const x = await e.api.webappOffer(m.sender || sender, msg(m)); assert.strictEqual(x.error, err, err); assert.strictEqual(e.calls.writes.length, 0, err); };
  await noWrite({ action: "reject", offerRequestId: "999", expectedPrice: "18" }, "offer-not-found");
  await noWrite({ action: "accept", offerRequestId: "555", expectedPrice: "18", transactionId: "778" }, "conversation-changed");
  await noWrite({ action: "accept", offerRequestId: "555", expectedPrice: "18", expectUserId: "101" }, "wrong-account");
  await noWrite({ action: "accept", offerRequestId: "555", expectedPrice: "18", requestKey: "x" }, "bad-request-key");
  await noWrite({ action: "accept", offerRequestId: "555", expectedPrice: "18", conv: "abc" }, "bad-conversation");
  await noWrite({ action: "state", sender: { id: "ext", url: "https://evil.example/" } }, "not-allowed");
  for (const price of ["0", "-1", "abc", "21.555", "123456", null]) await noWrite({ action: "offer", price }, "bad-price");
  // Transaktion nur im Angebot genannt ⇒ wird benutzt; gar keine Transaktion ⇒ no-transaction
  e = makeEnv({ details: [detail([request({ transaction_id: null })], { id: null })] }); enable(e.api, ...BINDING);
  r = await e.api.webappOffer(sender, msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" }));
  assert.deepStrictEqual([r.status, r.error, e.calls.writes.length], ["failed", "no-transaction", 0]);
  e = makeEnv({ details: [detail([request()], { id: null }), detail([request({ status: 20 })], { id: null })] }); enable(e.api, ...BINDING);
  r = await e.api.webappOffer(sender, msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" }));
  assert.deepStrictEqual([r.status, e.calls.writes[0].url], ["confirmed", `${TX}/offer_requests/555/accept`]);

  // 6) Doppelschutz: gleicher requestKey ⇒ ein Aufruf, gespeichertes Ergebnis; parallel in derselben Unterhaltung ⇒ busy
  e = makeEnv({ details: [detail([request()]), detail([request({ status: 20 })])] }); enable(e.api, "accept");
  const same = msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" });
  const first = await e.api.webappOffer(sender, same);
  const second = await e.api.webappOffer(sender, same);
  assert.deepStrictEqual([first.status, second.status, second.repeated, e.calls.writes.length], ["confirmed", "confirmed", true, 1]);
  let release;
  e = makeEnv({ reply: new Promise((res) => { release = res; }), details: [detail([request()])] }); enable(e.api, "accept", "reject");
  const p1 = e.api.webappOffer(sender, msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" }));
  await new Promise((res) => setTimeout(res, 30));
  const p2 = await e.api.webappOffer(sender, msg({ action: "reject", offerRequestId: "555", expectedPrice: "18" }));
  assert.strictEqual(p2.error, "busy");
  release({ ok: true, status: 200, json: {} });
  assert.strictEqual((await p1).status, "confirmed"); assert.strictEqual(e.calls.writes.length, 1);

  // 7) Ergebnisse: 5xx/Abbruch ⇒ unklar (nie wiederholt) – außer der neue Stand zeigt die Aktion; 4xx ⇒ failed; 403 ⇒ blocked
  const outcomes = [
    [{ ok: false, status: 502, json: null }, [detail([request()])], "unclear", "not-visible"],
    ["throw", [detail([request()])], "unclear", "not-visible"],
    [{ ok: false, status: 502, json: null }, [detail([request()]), detail([request({ status: 20 })])], "confirmed", "ok"],
    [{ ok: true, status: 200, json: null, text: "<html>Prüfung</html>" }, [detail([request()])], "unclear", "not-visible"],
    [{ ok: false, status: 422, json: { message: "Preis zu niedrig" } }, [detail([request()])], "failed", "not-visible"],
    [{ ok: false, status: 403, json: null, text: "captcha-delivery" }, [detail([request()])], "failed", "not-visible"],
  ];
  for (const [reply, details, status, check] of outcomes) {
    e = makeEnv({ reply, details }); enable(e.api, "accept");
    r = await e.api.webappOffer(sender, msg({ action: "accept", offerRequestId: "555", expectedPrice: "18" }));
    assert.deepStrictEqual([r.status, r.afterCheck, e.calls.writes.length], [status, check, 1], JSON.stringify(reply).slice(0, 40));
    if (reply && reply.status === 403) assert.strictEqual(r.error, "blocked");
    if (status === "confirmed" && reply && reply.status === 502) assert.strictEqual(r.resolvedBy, "after-check");
  }
  console.log("test-offers: ok");
})().catch((err) => { console.error(err); process.exit(1); });
