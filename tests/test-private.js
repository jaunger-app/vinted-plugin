process.env.TZ = "Europe/Berlin";
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const ctx = { window: { addEventListener() {} }, document: {}, localStorage: { getItem: () => null }, console, Intl, Date, Math, Map, Set };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require("path").join(__dirname, "..", "shared.js"), "utf8")
  + "\n;globalThis.__x = { prepareOrders, prepareSales, resellerModel, aggregate, itemInYear, manualToOrder, DEFAULT_SETTINGS };", ctx);
const X = ctx.__x;
const now = new Date(2026, 9, 11, 15);
const manual = [
  { id: "m-1", title: "Carhartt Weste braun", amount: 20, date: "2026-10-01", platform: "kleinanzeigen" },
  { id: "m-2", title: "Hoodie für mich", amount: 30, date: "2026-10-02", platform: "sonstige", platformOther: "Zalando" },
];
const orders = [
  { id: 1, title: "Levis 501 Jeans blau", amount: 15, status: "Bestellung abgeschlossen", date: "2026-10-03T10:00:00+02:00" },
  { id: 2, title: "Nike Air Max weiß", amount: 25, status: "Bestellung abgeschlossen", date: "2026-10-04T10:00:00+02:00" },
];
const purchases = X.prepareOrders([...orders, ...manual.map(X.manualToOrder)]);
const sales = X.prepareSales([
  { id: 11, title: "Carhartt Weste braun Vintage", amount: 50, status: "Bestellung abgeschlossen", date: "2026-10-08T12:00:00+02:00" },
  { id: 12, title: "Nike Air Max weiß", amount: 60, status: "Bestellung abgeschlossen", date: "2026-10-09T12:00:00+02:00" },
]);
const meta = { "m-2": { private: true }, 2: { private: true } }; // eigener privater + Vinted-Kauf privat
const m = X.resellerModel(purchases, meta, X.DEFAULT_SETTINGS, sales, {}, [{ id: "t", name: "Tüten", type: "monthly", amount: 10, qty: 100, start: "2026-01" }]);
const it = (id) => m.items.find((i) => String(i.id) === String(id));

assert.strictEqual(it("m-1").platform, "Kleinanzeigen");
assert.strictEqual(it("m-2").platform, "Zalando");
assert.strictEqual(it("m-2").rstatus, "stock", "eigener Kauf ohne Wahl = Im Lager");
assert.strictEqual(it("m-1").rstatus, "sold", "eigener Kauf wird Vinted-Verkauf zugeordnet");
assert.strictEqual(it("m-1").profit, 30);
assert.strictEqual(it(2).private, true);
assert.strictEqual(it(2).sale, null, "privater Kauf bekommt keine Zuordnung");

const y = X.aggregate(m.events, "year", 2026, now).total;
assert.strictEqual(y.boughtCount, 2, "nur Kauf 1 + m-1");
assert.strictEqual(y.spent, 35);
assert.strictEqual(y.soldCount, 2, "Verkäufe zählen weiter (Verkauf 12 ohne Kauf)");
assert.strictEqual(y.profitMissing, 1);
assert.strictEqual(m.summary.stockValue, 15, "Lager ohne Private (nur Kauf 1)");
assert.strictEqual(m.summary.countActive, 2);
assert.ok(!m.events.some((e) => e.item && e.item.private), "keine Ereignisse von Privaten");
assert.ok(X.itemInYear(it("m-2"), 2026, now));
assert.ok(!X.itemInYear(it("m-2"), 2027, new Date(2027, 1, 1)), "privat nur im Kaufjahr");
console.log("Privat-/Eigene-Käufe-Tests bestanden.");
