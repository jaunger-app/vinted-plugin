// Logiktest für shared.js (ohne Browser): Datum, Zuordnung, Modell, Zeiträume.
process.env.TZ = "Europe/Berlin";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const ctx = { window: { addEventListener() {} }, document: {}, localStorage: { getItem: () => null }, console, Intl, Date, Math, Map, Set };
vm.createContext(ctx);
const src = fs.readFileSync(require("path").join(__dirname, "..", "shared.js"), "utf8")
  + "\n;globalThis.__x = { parseDate, dayKey, monthKey, prepareOrders, prepareSales, linkSales, resellerModel, aggregate, DEFAULT_SETTINGS, flipRankings, categoryRevenue, brandBreakdown, categoryOf, categoryInfo, brandOf };";
vm.runInContext(src, ctx);
const X = ctx.__x;

// 1) Datum: lokale Tage, auch kurz nach Mitternacht (früher Bug: UTC-Verschiebung)
assert.strictEqual(X.dayKey("2026-10-11T00:30:00+02:00"), "2026-10-11");
assert.strictEqual(X.dayKey("2026-10-10T23:30:00Z"), "2026-10-11"); // 01:30 Berlin
assert.strictEqual(X.dayKey("2026-10-11"), "2026-10-11");           // input type=date
assert.strictEqual(X.dayKey(1791676800), X.dayKey(new Date(1791676800 * 1000)));
assert.strictEqual(X.monthKey("2026-03-31T23:59:00+02:00"), "2026-03");
assert.strictEqual(X.parseDate("quatsch"), null);

// 2) Daten
const now = new Date(2026, 9, 11, 15, 0); // 11.10.2026 15:00 lokal
const purchases = X.prepareOrders([
  { id: 1, title: "Levi's 501 Jeans W32 L32 blau", amount: 15, status: "Bestellung abgeschlossen", date: "2026-09-20T10:00:00+02:00" },
  { id: 2, title: "Carhartt Detroit Jacket braun L", amount: 40, status: "Bestellung abgeschlossen", date: "2026-10-01T10:00:00+02:00" },
  { id: 3, title: "Nike Air Max 90 weiß 43", amount: 30, status: "Rückerstattung abgeschlossen", date: "2026-10-05T10:00:00+02:00" },
  { id: 4, title: "Diesel Hoodie schwarz M", amount: 12, status: "Paket ist unterwegs", date: "2026-10-11T00:15:00+02:00" },
  { id: 5, title: "Stone Island Pullover grau", amount: 50, status: "Bestellung abgeschlossen", date: "2026-10-02T10:00:00+02:00" },
]);
const sales = X.prepareSales([
  { id: 101, title: "Levis 501 Jeans W32 L32", amount: 35, status: "Bestellung abgeschlossen", date: "2026-10-06T12:00:00+02:00" },
  { id: 102, title: "Carhartt Detroit Jacket L braun Vintage", amount: 90, status: "Bestellung abgeschlossen", date: "2026-10-11T00:05:00+02:00" },
  { id: 103, title: "Ganz anderer Artikel Rock", amount: 20, status: "Bestellung abgeschlossen", date: "2026-10-06T18:00:00+02:00" },
  { id: 104, title: "Storno Hemd", amount: 99, status: "Storniert", date: "2026-10-07T12:00:00+02:00" },
]);
assert.strictEqual(sales.length, 3, "stornierte Verkäufe raus");

// 3) Automatische Zuordnung
const { saleToPurchase } = X.linkSales(purchases, sales, {});
assert.strictEqual(saleToPurchase.get("101")?.purchaseId, "1");
assert.strictEqual(saleToPurchase.get("102")?.purchaseId, "2");
assert.ok(!saleToPurchase.get("103"), "kein Treffer für fremden Titel");

// 4) Modell + manueller Verkauf ohne Vinted (Kauf 5, woanders verkauft) + Zusatzkosten
const meta = { 5: { status: "sold", salePrice: "80", soldDate: "2026-10-09" }, 2: { extraCost: "5" } };
const m = X.resellerModel(purchases, meta, X.DEFAULT_SETTINGS, sales, {});
const it = (id) => m.items.find((i) => i.id === id);
assert.strictEqual(it(1).rstatus, "sold");
assert.strictEqual(it(1).profit, 20);
assert.strictEqual(it(2).profit, 90 - 45);
assert.strictEqual(it(3).rstatus, "refund");
assert.strictEqual(it(5).profit, 30);
const s = m.summary;
assert.strictEqual(s.soldCount, 4);              // 3 Vinted + 1 manuell
assert.strictEqual(s.revenue, 35 + 90 + 20 + 80);
assert.strictEqual(s.profit, 20 + 45 + 30);
assert.strictEqual(s.profitMissing, 1);          // Verkauf 103
assert.strictEqual(s.stockValue, 12);            // nur Kauf 4 unterwegs

// 5) Keine Doppelzählung: Kauf 1 zusätzlich manuell als verkauft markiert
const m2 = X.resellerModel(purchases, { ...meta, 1: { status: "sold", salePrice: "999", soldDate: "2026-10-08" } }, X.DEFAULT_SETTINGS, sales, {});
assert.strictEqual(m2.summary.soldCount, 4);
assert.strictEqual(m2.summary.revenue, s.revenue);

// 6) Manuelle Zuordnung: 103 → Kauf 4, und 101 gesperrt ("none")
const m3 = X.resellerModel(purchases, meta, X.DEFAULT_SETTINGS, sales, { 103: "4", 101: "none" });
assert.strictEqual(m3.items.find((i) => i.id === 4).rstatus, "sold");
assert.strictEqual(m3.items.find((i) => i.id === 1).rstatus, "stock");
assert.strictEqual(m3.summary.profitMissing, 1); // jetzt fehlt 101

// 7) Zeiträume (lokal, heute inklusive)
const a7 = X.aggregate(m.events, "7d", 2026, now);
assert.strictEqual(a7.buckets.length, 7);
assert.strictEqual(a7.buckets[6].key, "2026-10-11");
const today = a7.buckets[6];
assert.strictEqual(today.soldCount, 1, "Verkauf 00:05 Uhr zählt für heute");
assert.strictEqual(today.revenue, 90);
assert.strictEqual(today.boughtCount, 1, "Kauf 00:15 Uhr zählt für heute");
assert.strictEqual(today.spent, 12);
const d6 = a7.buckets.find((b) => b.key === "2026-10-06");
assert.strictEqual(d6.soldCount, 2);
assert.strictEqual(d6.profit, 20);
assert.strictEqual(d6.profitMissing, 1);
assert.strictEqual(a7.total.soldCount, 4);       // 06.(2), 09.(1), 11.(1)
assert.strictEqual(a7.total.boughtCount, 1);     // nur Kauf 4 (05.10. erstattet)

const a30 = X.aggregate(m.events, "30d", 2026, now);
assert.strictEqual(a30.buckets[0].key, "2026-09-12");
assert.strictEqual(a30.total.boughtCount, 4);    // 1,2,4,5 (3 erstattet)
assert.strictEqual(a30.total.spent, 15 + 45 + 12 + 50);

const a12 = X.aggregate(m.events, "year", 2026, now);
assert.strictEqual(a12.buckets.length, 12);
assert.strictEqual(a12.buckets[0].key, "2026-01");
assert.strictEqual(a12.buckets[11].key, "2026-12");
assert.strictEqual(a12.buckets[8].boughtCount, 1); // September: Kauf 1
assert.strictEqual(a12.buckets[9].boughtCount, 3);

// Sommerzeit-Wechsel (25.10.2026): Tage bleiben lückenlos
const dst = X.aggregate([], "7d", 2026, new Date(2026, 9, 27, 12));
assert.strictEqual(JSON.stringify(dst.buckets.map((b) => b.key)), JSON.stringify(["2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25","2026-10-26","2026-10-27"]));

// 8) Verteilungen
assert.strictEqual(X.categoryRevenue(a30.events).total, 225);
assert.ok(X.flipRankings(a30.events).single.length === 3);
assert.strictEqual(X.brandBreakdown(a30.events).total, 122);

// Kategorie und Marke: ganze Wörter statt Wortstücke (gleiche Fälle wie in der Web-App)
const cat = (t, p) => X.categoryOf(t, p);
assert.strictEqual(cat("Levi's 527 Bootcut W32"), "Hosen & Jeans"); // früher „Schuhe“ wegen „boot“
assert.strictEqual(cat("Jeansjacke Levi's Trucker"), "Jacken & Mäntel");
assert.strictEqual(cat("Nike Air Max Sneaker 42"), "Schuhe");
assert.strictEqual(cat("Pantoffeln Filz grau"), "Schuhe");
assert.strictEqual(cat("Handschuhe Leder"), "Accessoires");
assert.strictEqual(cat("Fleece Pulli Patagonia"), "Pullover & Hoodies");
assert.strictEqual(cat("Top Zustand! Diesel Jeans"), "Hosen & Jeans");
assert.strictEqual(cat("Pepe Jeans Pullover grau"), "Pullover & Hoodies");
assert.strictEqual(cat("Stopper Gummi"), "Sonstige");
assert.strictEqual(cat("Schöner Artikel", "Damen › Schuhe › Stiefel"), "Schuhe");
assert.strictEqual(X.categoryInfo({ id: "s1", title: "Levi's Jeans" }, { s1: "Schuhe" }).source, "manual");
assert.strictEqual(X.brandOf("Fleece Jacke grün"), "Sonstige");
assert.strictEqual(X.brandOf("Lee Jeans W30"), "Lee");
assert.strictEqual(X.brandOf("Jacke only worn once"), "Sonstige");
assert.strictEqual(X.brandOf("Only Jeans Damen"), "Only");

console.log("Alle Logiktests bestanden.");
