// Tests: Betriebskosten-Verteilung und Geschäftsjahr.
process.env.TZ = "Europe/Berlin";
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const ctx = { window: { addEventListener() {} }, document: {}, localStorage: { getItem: () => null }, console, Intl, Date, Math, Map, Set };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require("path").join(__dirname, "..", "shared.js"), "utf8")
  + "\n;globalThis.__x = { prepareOrders, prepareSales, resellerModel, aggregate, availableYears, itemInYear, DEFAULT_SETTINGS };", ctx);
const X = ctx.__x;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const now = new Date(2026, 9, 11, 15);

const purchases = X.prepareOrders([
  { id: 1, title: "Alpha Jacke rot", amount: 10, status: "Bestellung abgeschlossen", date: "2025-12-10T10:00:00+01:00" },
  { id: 2, title: "Beta Hose blau", amount: 10, status: "Bestellung abgeschlossen", date: "2026-01-05T10:00:00+01:00" },
  { id: 3, title: "Gamma Pulli grün", amount: 10, status: "Bestellung abgeschlossen", date: "2025-06-01T10:00:00+02:00" }, // unverkauft, Vorjahr
  { id: 4, title: "Delta Schuhe weiß", amount: 10, status: "Bestellung abgeschlossen", date: "2025-03-01T10:00:00+01:00" },
]);
const sales = X.prepareSales([
  { id: 11, title: "Alpha Jacke rot", amount: 30, status: "Bestellung abgeschlossen", date: "2026-02-03T12:00:00+01:00" },
  { id: 12, title: "Beta Hose blau", amount: 30, status: "Bestellung abgeschlossen", date: "2026-02-20T12:00:00+01:00" },
  { id: 13, title: "Fremd Teil", amount: 20, status: "Bestellung abgeschlossen", date: "2026-03-01T12:00:00+01:00" },
  { id: 14, title: "Delta Schuhe weiß", amount: 30, status: "Bestellung abgeschlossen", date: "2025-04-01T12:00:00+02:00" }, // Vorjahr
]);
const costs = [
  { id: "drucker", name: "Drucker", type: "once", amount: 5, perPiece: 2, date: "2025-01-01" },     // 2+2+1 → abbezahlt
  { id: "waage", name: "Waage", type: "once", amount: 10, perPiece: 1, date: "2026-02-10" },       // ab 10.2.: 2 Verkäufe
  { id: "tueten", name: "Tüten", type: "monthly", amount: 15, qty: 100, start: "2026-02" },        // 0,15 / Stück ab Feb
  { id: "abo", name: "Abo", type: "monthly", amount: 10, start: "2026-02", end: "2026-02" },        // nur Feb, auf 2 Verkäufe
];
const m = X.resellerModel(purchases, {}, X.DEFAULT_SETTINGS, sales, {}, costs);
const ev = (sid) => m.events.find((e) => e.saleId === sid);

// Vorjahresverkauf 14: Drucker 2 €
near(ev(14).costs, 2, "Verkauf 2025 zahlt Drucker");
// 11 (3.2.): Drucker 2 + Tüte 0,15 + Abo 5
near(ev(11).costs, 7.15, "Verkauf 11");
// 12 (20.2.): Drucker Rest 1 + Waage 1 + Tüte 0,15 + Abo 5 → gleichzeitige Abzahlung
near(ev(12).costs, 7.15, "Verkauf 12");
// 13 (1.3., ohne Kauf): Waage 1 + Tüte 0,15, Drucker abbezahlt, Abo vorbei
near(ev(13).costs, 1.15, "Verkauf 13 ohne Kauf trägt Kosten");
assert.strictEqual(ev(13).netProfit, null);

assert.strictEqual(m.costStats.drucker.remaining, 0);
assert.strictEqual(m.costStats.drucker.paidOffAt, "2026-02-20T12:00:00+01:00");
near(m.costStats.waage.remaining, 8, "Waage Rest");
near(m.costStats.drucker.chargedByYear["2026"], 3, "Drucker 2026");

// Netto-Gewinn je Artikel (Kauf 1 aus 2025, verkauft 2026)
near(m.items.find((i) => i.id === 1).netProfit, 20 - 7.15, "Netto Artikel 1");

// Jahr 2026
const y = X.aggregate(m.events, "year", 2026, now);
assert.strictEqual(y.total.soldCount, 3);
near(y.total.revenue, 80, "Umsatz 2026");
near(y.total.grossProfit, 40, "Rohgewinn 2026 (11 + 12)");
near(y.total.costs, 15.45, "Kosten 2026");
near(y.total.profit, 40 - 15.45, "Netto 2026");
assert.strictEqual(y.total.boughtCount, 1, "nur Kauf 2 in 2026");
// Jahr 2025 getrennt
const y5 = X.aggregate(m.events, "year", 2025, now);
assert.strictEqual(y5.total.soldCount, 1);
assert.strictEqual(y5.total.boughtCount, 3);

// 30 T am 10.1. → nur 1.–10.1.
const jan = X.aggregate(m.events, "30d", 2026, new Date(2026, 0, 10, 12));
assert.strictEqual(jan.buckets.length, 10);
assert.strictEqual(jan.buckets[0].key, "2026-01-01");
// 30 T eines Vorjahres enden am 31.12.
const old = X.aggregate(m.events, "30d", 2025, now);
assert.strictEqual(old.buckets[29].key, "2025-12-31");

// Jahre und Käufe-Liste
assert.strictEqual(JSON.stringify(X.availableYears(m.events, now)), "[2026,2025]");
const inYear = (id, yr) => X.itemInYear(m.items.find((i) => i.id === id), yr, now);
assert.ok(inYear(1, 2026), "2025 gekauft, 2026 verkauft → 2026");
assert.ok(inYear(3, 2026), "unverkauft aus 2025 bleibt im laufenden Jahr");
assert.ok(!inYear(4, 2026), "2025 gekauft und verkauft → nicht in 2026");
assert.ok(inYear(4, 2025));

// Ohne Kosten bleibt alles wie vorher
const m0 = X.resellerModel(purchases, {}, X.DEFAULT_SETTINGS, sales, {}, []);
near(X.aggregate(m0.events, "year", 2026, now).total.profit, 40, "ohne Kosten netto = brutto");
console.log("Kosten- und Jahrestests bestanden.");
