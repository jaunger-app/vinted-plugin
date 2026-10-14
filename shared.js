// Gemeinsame Funktionen für das kleine Fenster (Popup) und die große Übersicht.

const PHASES = [
  { key: "paid",    label: "Bezahlt",                color: "var(--p-paid)" },
  { key: "label",   label: "Versandschein erstellt", color: "var(--p-label)" },
  { key: "transit", label: "Unterwegs",              color: "var(--p-transit)" },
  { key: "done",    label: "Abgeschlossen",          color: "var(--p-done)" },
  { key: "refund",  label: "Erstattet",              color: "var(--p-refund)" },
  { key: "other",   label: "Sonstiges",              color: "var(--p-other)" },
];
const PHASE_BY_KEY = Object.fromEntries(PHASES.map((p) => [p.key, p]));

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });

// ---------- Datum: immer lokale Zeit ----------
// toISOString() rechnet in UTC und verschiebt in Deutschland jeden Tag um eins.

function parseDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d) ? null : d;
  }
  // Reines Datum (z. B. aus <input type="date">) als lokalen Tag lesen, nicht als UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  return isNaN(d) ? null : d;
}
const pad2 = (n) => String(n).padStart(2, "0");
function dayKey(v) {
  const d = parseDate(v);
  return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : null;
}
function monthKey(v) {
  const d = parseDate(v);
  return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` : null;
}

function phaseOf(o) {
  const s = (o.status || "").toLowerCase();
  if (o.userStatus === "failed" || s.includes("rückerstattung") || s.includes("storniert")) return "refund";
  if (s.includes("verschickt") || s.includes("unterwegs") || s.includes("auf dem weg")) return "transit";
  if (s.includes("versandschein")) return "label";
  if (s.includes("zahlung")) return "paid";
  if (o.userStatus === "completed" || s.includes("abgeschlossen") || s.includes("zugestellt") || s.includes("erhalten")) return "done";
  return "other";
}

function prepareOrders(list) {
  return (Array.isArray(list) ? list : [])
    .map((o) => ({ ...o, phase: phaseOf(o) }))
    .sort((a, b) => (parseDate(b.date) || 0) - (parseDate(a.date) || 0));
}

// Vinted-Verkäufe ohne stornierte/erstattete.
function prepareSales(list) {
  return prepareOrders(list).filter((s) => s.phase !== "refund");
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function dot(color) {
  const d = el("span", { className: "dot" });
  d.style.background = color;
  return d;
}

function thumb(o) {
  const img = el("img", { className: "thumb", alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
  if (o.photo) img.src = o.photo;
  img.addEventListener("error", () => img.removeAttribute("src"));
  return img;
}

function renderBar(barEl, groups) {
  barEl.replaceChildren(...groups.map((g) => {
    const seg = el("span");
    seg.style.flexGrow = String(g.count);
    seg.style.background = (g.status || g.phase).color;
    return seg;
  }));
}

function updatedText(updatedAt) {
  return updatedAt ? `Zuletzt aktualisiert: ${dateFmt.format(new Date(updatedAt))}` : "Noch nicht geladen";
}

// ---------- Laden (läuft im Hintergrund, siehe background.js) ----------

function requestLoad() {
  chrome.runtime.sendMessage({ type: "load" });
}

function showLoadState(state, statusEl, loadBtn, idleLabel = "Jetzt aktualisieren") {
  const visible = !!state && (state.running || state.kind !== "ok" || Date.now() - state.at < 60000);
  statusEl.hidden = !visible;
  if (visible) {
    statusEl.textContent = state.text;
    statusEl.dataset.kind = state.kind;
  }
  if (loadBtn) {
    loadBtn.disabled = !!state?.running;
    loadBtn.textContent = state?.running ? "Lädt …" : idleLabel;
  }
}

function watchLoadState(statusEl, loadBtn, idleLabel) {
  chrome.storage.session.get("loadState").then(({ loadState }) => showLoadState(loadState, statusEl, loadBtn, idleLabel));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.loadState) showLoadState(changes.loadState.newValue, statusEl, loadBtn, idleLabel);
  });
}

function watchOrders(callback) {
  const keys = ["orders", "updatedAt"];
  chrome.storage.local.get(keys).then(({ orders, updatedAt }) => callback(orders, updatedAt));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.orders || changes.sales || changes.meta || changes.saleLinks || changes.settings || changes.costs || changes.manualOrders)) {
      chrome.storage.local.get(keys).then(({ orders, updatedAt }) => callback(orders, updatedAt));
    }
  });
}

// ---------- Hell / Dunkel / System ----------
// Die Wahl liegt in localStorage (Popup und Übersicht teilen sich den Speicher
// der Erweiterung); theme-init.js setzt sie vor dem ersten Zeichnen.

const THEMES = ["system", "light", "dark"];
function getTheme() {
  try { const t = localStorage.getItem("theme"); return THEMES.includes(t) ? t : "system"; } catch { return "system"; }
}
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function setTheme(t) {
  try { localStorage.setItem("theme", t); } catch { /* nur für diese Sitzung */ }
  applyTheme(t);
}
// Wechselt ein anderes Fenster der Erweiterung das Theme, hier nachziehen.
window.addEventListener("storage", (e) => { if (e.key === "theme") applyTheme(getTheme()); });

// ---------- TEST: Reset-Button – vor der finalen Version entfernen ----------

async function resetData() {
  await chrome.storage.local.remove(["orders", "sales", "listings", "updatedAt", "meta", "saleLinks", "manualOrders"]);
  await chrome.storage.session.remove(["loadState", "sync"]);
  chrome.action.setBadgeText({ text: "" });
}

// Erster Klick fragt nach, zweiter Klick innerhalb von 3 Sekunden löscht.
function setupResetButton(btn) {
  const label = btn.textContent;
  let timer = null;
  btn.addEventListener("click", async () => {
    if (!timer) {
      btn.textContent = "Wirklich löschen?";
      btn.dataset.armed = "true";
      timer = setTimeout(() => { timer = null; btn.textContent = label; delete btn.dataset.armed; }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.textContent = label;
    delete btn.dataset.armed;
    await resetData();
  });
}

// ======================= Reseller-Logik =======================

const RESELLER_STATUS = [
  { key: "transit", label: "Unterwegs", color: "var(--p-paid)",   manual: false },
  { key: "stock",   label: "Im Lager",  color: "var(--p-done)",   manual: true },
  { key: "listed",  label: "Gelistet",  color: "var(--p-listed)", manual: true },
  { key: "sold",    label: "Verkauft",  color: "var(--p-transit)",manual: true },
  { key: "problem", label: "Problem",   color: "var(--p-label)",  manual: true },
  { key: "refund",  label: "Erstattet", color: "var(--p-refund)", manual: false },
];
// Diese Phasen zählen alle als gebundenes Kapital (Ware, die noch Geld bringen soll).
const BOUND_STATUS = ["transit", "stock", "listed"];
// Automatischer Status aus der Vinted-Versandphase, solange nichts manuell gewählt ist.
function autoStatus(phase) {
  if (phase === "refund") return "refund";
  return phase === "done" ? "stock" : "transit";
}
const STATUS_BY_KEY = Object.fromEntries(RESELLER_STATUS.map((s) => [s.key, s]));

const EXPORT_COLUMNS = [
  { key: "datum",        label: "Kaufdatum" },
  { key: "artikel",      label: "Artikel" },
  { key: "kaufpreis",    label: "Kaufpreis" },
  { key: "zusatzkosten", label: "Zusatzkosten" },
  { key: "verkaufspreis",label: "Verkaufspreis" },
  { key: "betriebskosten", label: "Betriebskosten-Anteil" },
  { key: "gewinn",       label: "Gewinn (nach Kosten)" },
  { key: "rendite",      label: "Rendite %" },
  { key: "status",       label: "Status" },
  { key: "haltedauer",   label: "Haltedauer (Tage)" },
  { key: "verkaufsdatum",label: "Verkaufsdatum" },
  { key: "phase",        label: "Versandphase" },
  { key: "statustext",   label: "Status laut Vinted" },
  { key: "id",           label: "Transaktions-ID" },
];

const DEFAULT_SETTINGS = {
  columns: {
    datum: true, artikel: true, kaufpreis: true, zusatzkosten: false,
    verkaufspreis: true, betriebskosten: true, gewinn: true, rendite: true, status: true,
    haltedauer: false, verkaufsdatum: false, phase: false, statustext: false, id: true,
  },
  includeRefunds: false,
  delimiter: ";",
  decimal: ",",
  defaultExtraCost: 0,
};

const num = (v) => {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const dayDiff = (a, b) => {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  return Math.max(0, Math.round((db - da) / 86400000));
};

// ---------- Zuordnung Vinted-Verkauf → Kauf ----------

function tokenize(t) {
  return new Set(String(t).toLowerCase().replace(/[^a-z0-9äöüß ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}
// Überlappung relativ zum kürzeren Titel; mindestens zwei gemeinsame Wörter
// (außer ein Titel hat nur eins), damit „Jeans“ allein nicht reicht.
function titleScore(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  if (inter < Math.min(2, a.size, b.size)) return 0;
  return inter / Math.min(a.size, b.size);
}
const LINK_MIN_SCORE = 0.5;

// Ordnet jedem Verkauf höchstens einen Kauf zu und umgekehrt. Manuelle
// Zuordnungen (links: saleId → purchaseId oder "none") haben Vorrang, der Rest
// wird nach Titelähnlichkeit vergeben, bester Treffer zuerst. Gekauft werden
// muss vor dem Verkauf.
function linkSales(purchases, sales, links = {}) {
  const saleToPurchase = new Map();   // saleId → { purchaseId, auto } | null
  const purchaseToSale = new Map();   // purchaseId → { saleId, auto }
  const purchaseIds = new Set(purchases.map((p) => String(p.id)));

  for (const s of sales) {
    const sid = String(s.id);
    const l = links[sid];
    if (l == null) continue;
    if (l === "none") { saleToPurchase.set(sid, null); continue; }
    const pid = String(l);
    if (purchaseIds.has(pid) && !purchaseToSale.has(pid)) {
      saleToPurchase.set(sid, { purchaseId: pid, auto: false });
      purchaseToSale.set(pid, { saleId: sid, auto: false });
    }
  }

  const free = purchases
    .filter((p) => p.phase !== "refund" && !purchaseToSale.has(String(p.id)))
    .map((p) => ({ pid: String(p.id), tokens: tokenize(p.title), date: parseDate(p.date) }));
  const pairs = [];
  for (const s of sales) {
    const sid = String(s.id);
    if (saleToPurchase.has(sid)) continue;
    const tokens = tokenize(s.title);
    const date = parseDate(s.date);
    for (const p of free) {
      if (date && p.date && p.date > date) continue;
      const score = titleScore(tokens, p.tokens);
      if (score >= LINK_MIN_SCORE) pairs.push({ sid, pid: p.pid, score, gap: date && p.date ? date - p.date : Infinity });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.gap - b.gap);
  for (const { sid, pid } of pairs) {
    if (saleToPurchase.has(sid) || purchaseToSale.has(pid)) continue;
    saleToPurchase.set(sid, { purchaseId: pid, auto: true });
    purchaseToSale.set(pid, { saleId: sid, auto: true });
  }
  return { saleToPurchase, purchaseToSale };
}

// Käufe + Vinted-Verkäufe + manuelle Angaben (meta) zu einem Modell verrechnen.
// Ergebnis: items (ein Eintrag je Kauf), events (Käufe und Verkäufe mit Datum,
// Grundlage für Diagramm und Zeitraum-Summen) und summary (Gesamtwerte).
function resellerModel(purchases, meta, settings, sales = [], links = {}, costs = []) {
  // Private Käufe sind nur zur Ansicht: keine Zuordnung, keine Ereignisse, keine Summen.
  const isPrivate = (p) => !!meta[p.id]?.private;
  const { saleToPurchase, purchaseToSale } = linkSales(purchases.filter((p) => !isPrivate(p)), sales, links);
  const saleById = new Map(sales.map((s) => [String(s.id), s]));

  const items = purchases.map((p) => {
    const m = meta[p.id] || {};
    const refunded = p.phase === "refund";
    const extra = m.extraCost != null && m.extraCost !== "" ? num(m.extraCost) : num(settings.defaultExtraCost);
    const cost = p.amount + extra;
    const link = refunded ? null : purchaseToSale.get(String(p.id));
    const sale = link ? saleById.get(link.saleId) : null;
    // Eigene Käufe haben keine Versandphase → ohne Wahl „Im Lager“.
    const auto = refunded ? "refund" : sale ? "sold" : p.source === "manual" ? "stock" : autoStatus(p.phase);
    // Vorrang: Erstattung → zugeordneter Vinted-Verkauf → manuelle Wahl → Versandphase.
    const status = refunded ? "refund" : sale ? "sold" : (m.status || auto);
    const salePrice = sale ? sale.amount : (m.salePrice != null && m.salePrice !== "" ? num(m.salePrice) : null);
    const soldDate = sale ? sale.date : (m.soldDate || null);
    const isSold = status === "sold" && salePrice != null;
    const profit = isSold ? salePrice - cost : null;
    const roi = isSold && cost > 0 ? profit / cost : null;
    const hold = isSold && soldDate ? dayDiff(p.date, soldDate) : null;
    return {
      ...p, extra, cost, rstatus: status, autoStatus: auto, salePrice, soldDate, profit, roi, hold,
      note: m.note || "", sale: sale || null, saleAuto: link ? link.auto : null, private: isPrivate(p),
    };
  });
  const itemById = new Map(items.map((i) => [String(i.id), i]));

  const events = [];
  for (const s of sales) {
    const link = saleToPurchase.get(String(s.id));
    const item = link ? itemById.get(link.purchaseId) : null;
    events.push({
      kind: "sale", id: `s${s.id}`, saleId: s.id, date: s.date, title: s.title, photo: s.photo,
      revenue: s.amount, profit: item ? s.amount - item.cost : null, item: item || null, auto: link ? link.auto : null,
    });
  }
  for (const i of items) {
    if (i.rstatus === "refund" || i.private) continue;
    events.push({ kind: "purchase", id: `p${i.id}`, date: i.date, title: i.title, photo: i.photo, spent: i.cost, item: i });
    // Manuell als verkauft markiert (z. B. außerhalb von Vinted verkauft).
    if (i.rstatus === "sold" && i.salePrice != null && !i.sale) {
      events.push({ kind: "sale", id: `m${i.id}`, date: i.soldDate, title: i.title, photo: i.photo, revenue: i.salePrice, profit: i.profit, item: i, manual: true });
    }
  }

  // Betriebskosten auf die Verkäufe verteilen und den Netto-Gewinn je Artikel setzen.
  const costStats = allocateCosts(events, costs);
  for (const e of events) {
    if (e.kind !== "sale") continue;
    e.netProfit = e.profit != null ? e.profit - e.costs : null;
    if (e.item) {
      e.item.saleCosts = e.costs;
      e.item.costParts = e.costParts;
      e.item.netProfit = e.netProfit;
    }
  }

  const active = items.filter((i) => i.rstatus !== "refund" && !i.private);
  const bound = active.filter((i) => BOUND_STATUS.includes(i.rstatus));
  const soldItems = active.filter((i) => i.rstatus === "sold" && i.salePrice != null);
  const saleEvents = events.filter((e) => e.kind === "sale");
  const known = saleEvents.filter((e) => e.profit != null);
  const profit = known.reduce((s, e) => s + e.profit, 0);
  const costOfSold = known.reduce((s, e) => s + e.item.cost, 0);
  const holds = soldItems.map((i) => i.hold).filter((h) => h != null);
  const count = (k) => active.filter((i) => i.rstatus === k).length;

  return {
    items,
    events,
    costStats,
    summary: {
      invested: active.reduce((s, i) => s + i.cost, 0),
      stockValue: bound.reduce((s, i) => s + i.cost, 0),
      revenue: saleEvents.reduce((s, e) => s + e.revenue, 0),
      profit,
      profitMissing: saleEvents.length - known.length,
      soldCount: saleEvents.length,
      roi: costOfSold > 0 ? profit / costOfSold : null,
      sellThrough: (soldItems.length + bound.length) > 0 ? soldItems.length / (soldItems.length + bound.length) : null,
      avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      countTransit: count("transit"),
      countStock: count("stock"),
      countListed: count("listed"),
      countSold: count("sold"),
      countProblem: count("problem"),
      countActive: active.length,
    },
  };
}

// ---------- Betriebskosten ----------
// Einträge: { id, name, desc, type: "once"|"monthly", amount, perPiece, qty, date, start, end }
//   einmalig  – wird von jedem Verkauf ab dem Kaufdatum mit perPiece abbezahlt, bis nichts mehr offen ist
//               (mehrere offene Einträge zahlen gleichzeitig ab)
//   monatlich – mit Stückzahl: amount/qty pro verkauftem Stück;
//               ohne Stückzahl: amount verteilt auf die Verkäufe des Monats.
//               Nicht verbrauchter Vorrat wird nicht abgezogen.
// Gerechnet wird in Cent über alle Verkäufe aller Jahre, damit Abzahlungen über
// den Jahreswechsel weiterlaufen. Setzt an jedem Verkauf costs und costParts.

const toCents = (v) => Math.round(num(v) * 100);

function allocateCosts(events, costs = []) {
  const sales = events.filter((e) => e.kind === "sale");
  for (const e of sales) { e.costs = 0; e.costParts = []; }
  const stats = {};
  for (const c of costs) stats[c.id] = { charged: 0, chargedByYear: {}, count: 0, remaining: null, paidOffAt: null };

  const dated = sales.filter((e) => dayKey(e.date)).sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const perMonth = {};
  for (const e of dated) { const m = monthKey(e.date); perMonth[m] = (perMonth[m] || 0) + 1; }

  const remaining = {};
  for (const c of costs) if (c.type === "once") remaining[c.id] = toCents(c.amount);

  for (const e of dated) {
    const day = dayKey(e.date);
    const month = day.slice(0, 7);
    const year = day.slice(0, 4);
    for (const c of costs) {
      let cents = 0;
      if (c.type === "once") {
        if (!c.date || day < c.date || remaining[c.id] <= 0) continue;
        cents = Math.min(toCents(c.perPiece), remaining[c.id]);
        remaining[c.id] -= cents;
        if (remaining[c.id] <= 0 && cents > 0) stats[c.id].paidOffAt = e.date;
      } else {
        if (!c.start || month < c.start || (c.end && month > c.end)) continue;
        const qty = Math.round(num(c.qty));
        cents = qty > 0 ? toCents(c.amount) / qty : toCents(c.amount) / perMonth[month];
      }
      if (cents <= 0) continue;
      const amount = cents / 100;
      e.costs += amount;
      e.costParts.push({ id: c.id, name: c.name, amount });
      const st = stats[c.id];
      st.charged += amount;
      st.chargedByYear[year] = (st.chargedByYear[year] || 0) + amount;
      st.count += 1;
    }
  }
  for (const c of costs) if (c.type === "once") stats[c.id].remaining = Math.max(0, remaining[c.id]) / 100;
  return stats;
}

// ---------- Geschäftsjahr & Zeiträume ----------
// Alles wird pro Kalenderjahr (1.1.–31.12.) gerechnet. 7/30/90 Tage enden heute
// (bzw. am 31.12. eines vergangenen Jahres) und werden am 1.1. abgeschnitten.

const RANGES = {
  "7d":   { key: "7d",   label: "7 Tage",  short: "7 T",  days: 7 },
  "30d":  { key: "30d",  label: "30 Tage", short: "30 T", days: 30 },
  "90d":  { key: "90d",  label: "90 Tage", short: "90 T", days: 90 },
  "year": { key: "year", label: "Jahr",    short: "Jahr", year: true },
};

function yearOf(v) { const d = parseDate(v); return d ? d.getFullYear() : null; }

// Jahre, für die es Daten gibt (plus das laufende), neuestes zuerst.
function availableYears(events, now = new Date()) {
  const years = new Set([now.getFullYear()]);
  for (const e of events) { const y = yearOf(e.date); if (y && y <= now.getFullYear()) years.add(y); }
  return [...years].sort((a, b) => b - a);
}

// Gehört ein Kauf in die Liste des Jahres? Im Jahr gekauft oder verkauft –
// oder im laufenden Jahr noch im Bestand (auch wenn er aus dem Vorjahr stammt).
function itemInYear(i, year, now = new Date()) {
  if (yearOf(i.date) === year) return true;
  if (i.private) return false; // Private: nur im Kaufjahr
  if (i.rstatus === "sold" && yearOf(i.soldDate) === year) return true;
  return year === now.getFullYear() && (BOUND_STATUS.includes(i.rstatus) || i.rstatus === "problem");
}

function emptyBucket(o) {
  return { ...o, soldCount: 0, revenue: 0, grossProfit: 0, costs: 0, profit: 0, profitMissing: 0, boughtCount: 0, spent: 0 };
}
function addEvent(b, e) {
  if (e.kind === "sale") {
    b.soldCount += 1;
    b.revenue += e.revenue;
    b.costs += e.costs || 0;
    if (e.profit == null) b.profitMissing += 1; else b.grossProfit += e.profit;
    b.profit = b.grossProfit - b.costs;
  } else {
    b.boughtCount += 1;
    b.spent += e.spent;
  }
}

// Ereignisse in Tages- bzw. Monats-Buckets des Geschäftsjahres einsortieren (lokale Zeit).
function aggregate(events, rangeKey, year, now = new Date()) {
  const range = RANGES[rangeKey] || RANGES["30d"];
  if (year == null) year = now.getFullYear();
  const monthly = !!range.year;
  const end = year >= now.getFullYear() ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(year, 11, 31);
  const yearStart = new Date(year, 0, 1);
  const buckets = [];
  if (monthly) {
    for (let mo = 0; mo < 12; mo++) {
      const start = new Date(year, mo, 1);
      buckets.push(emptyBucket({ key: monthKey(start), start, end: new Date(year, mo + 1, 1) }));
    }
  } else {
    for (let k = range.days - 1; k >= 0; k--) {
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - k);
      if (start < yearStart) continue;
      buckets.push(emptyBucket({ key: dayKey(start), start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) }));
    }
  }
  const index = new Map(buckets.map((b) => [b.key, b]));
  const total = emptyBucket({ key: "total", start: buckets[0].start, end: buckets[buckets.length - 1].end });
  const keyOf = monthly ? monthKey : dayKey;
  const inRange = [];
  for (const e of events) {
    const b = index.get(keyOf(e.date));
    if (!b) continue;
    addEvent(b, e);
    addEvent(total, e);
    inRange.push(e);
  }
  return { range, year, monthly, buckets, total, events: inRange };
}

// Kategorie und Marke aus Titel (bzw. Vinted-Kategoriepfad, nur Web-App) – gespiegelt aus vinted-webapp/src/lib/model.ts.
// Titel in Wörter zerlegen: klein, Umlaute ausgeschrieben, Apostroph entfernt („Levi's“ → „levis“),
// an allem anderen getrennt („T-Shirt“ → „t“, „shirt“). Wortstücke wie „boot“ in „Bootcut“ zählen so nicht mehr.
function titleTokens(text) {
  return String(text || "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/['’`´]/g, "")
    .split(/[^a-z0-9]+/).filter(Boolean);
}
const BRANDS = [
  "Levi's", "Levis", "Adidas", "Nike", "Diesel", "G-Star", "Wrangler", "Lee",
  "Pepe Jeans", "Kaporal", "Dolce & Gabbana", "Dolce and Gabbana", "Tommy Hilfiger",
  "Carhartt", "Dickies", "Pull & Bear", "Zara", "Puma", "Reebok", "Lacoste",
  "Hugo Boss", "Jack & Jones", "Only", "Vero Moda", "Bershka", "Hollister",
  "The North Face", "North Face", "Ralph Lauren", "Polo Ralph Lauren", "Stone Island", "New Balance", "Converse", "Vans",
  "H&M", "Mango", "Esprit", "Calvin Klein", "Guess", "Champion", "Fila", "Asics", "Dr. Martens", "Timberland",
  "Patagonia", "Napapijri", "Superdry", "Stüssy", "Stussy", "Fred Perry", "Ellesse", "Kappa", "Uniqlo", "Massimo Dutti",
  "Abercrombie & Fitch", "Gant", "Scotch & Soda", "S.Oliver", "Tom Tailor", "Mustang", "Armani", "Michael Kors", "Birkenstock",
];
const BRAND_NORMALIZE = {
  "Levis": "Levi's", "Dolce and Gabbana": "Dolce & Gabbana", "North Face": "The North Face",
  "Polo Ralph Lauren": "Ralph Lauren", "Stussy": "Stüssy",
};
// „Only“ ist auch ein englisches Wort („only worn once“) – zählt nur ganz vorne im Titel.
const BRAND_ONLY_AT_START = new Set(["Only"]);
const BRAND_TOKENS = BRANDS.map((name) => ({ name, tokens: titleTokens(name) }))
  .sort((a, b) => b.tokens.length - a.tokens.length);
// Angaben von Vinted, die keine Marke sind
const NO_BRAND = new Set(["", "ohne marke", "keine marke", "no brand", "unbranded", "sonstige", "andere"]);
/** Erste Marke im Titel (ganze Wörter): { name, start, end } oder null. */
function findBrand(tokens) {
  let best = null;
  for (const { name, tokens: bt } of BRAND_TOKENS) {
    for (let i = 0; i + bt.length <= tokens.length; i++) {
      if (BRAND_ONLY_AT_START.has(name) && i > 0)
        break;
      if (!bt.every((t, k) => tokens[i + k] === t))
        continue;
      if (!best || i < best.start)
        best = { name: BRAND_NORMALIZE[name] || name, start: i, end: i + bt.length };
      break;
    }
  }
  return best;
}
/** Marke: von Vinted gelieferte zuerst, sonst aus dem Titel (ganze Wörter), sonst „Sonstige“. */
function brandOf(title, vintedBrand) {
  const vb = String(vintedBrand || "").trim();
  if (!NO_BRAND.has(vb.toLowerCase()))
    return BRAND_NORMALIZE[vb] || vb;
  return findBrand(titleTokens(title))?.name || "Sonstige";
}
/** Verteilung der Käufe (Ereignisse) nach Marke, nach Einkaufswert sortiert. */
function brandBreakdown(events) {
  const map = new Map();
  let total = 0;
  for (const e of events) {
    if (e.kind !== "purchase")
      continue;
    const b = brandOf(e.title);
    const cur = map.get(b) || { brand: b, count: 0, value: 0 };
    cur.count += 1;
    cur.value += e.spent;
    map.set(b, cur);
    total += e.spent;
  }
  return { rows: [...map.values()].sort((a, b) => b.value - a.value), total };
}
// Kategorien aus Wörtern. Schreibweise in den Listen (ohne Umlaute, klein):
//   "jeans"   – Wort muss genau so lauten
//   "~jacke"  – Wort darf so enden (deutsches Kompositum: „Jeansjacke“, „Lederjacke“)
//   "+rock"   – nur als Wortende eines längeren Wortes („Minirock“; „Rock“ allein ist nur ein schwacher Hinweis)
// strong zählt 2 Punkte, weak 1. Pro Wort gilt der längste Treffer („Handschuhe“ → Accessoires, nicht Schuhe).
// Die meisten Punkte gewinnen, bei Gleichstand der Treffer, der im Titel früher steht.
const CATEGORY_WORDS = {
  "Hosen & Jeans": {
    strong: ["~jeans", "jean", "~hose", "~hosen", "pants", "pant", "trousers", "trouser", "chino", "chinos", "leggings", "legging",
      "jeggings", "joggers", "jogger", "culotte", "culottes", "cargos"],
    weak: ["denim", "cargo", "bootcut", "skinny", "slim", "straight", "flared", "baggy", "mom", "wide", "loose", "tapered", "501", "/^w\\d{2}$/", "/^l\\d{2}$/"],
  },
  "Shorts": { strong: ["~shorts", "bermuda", "bermudas", "hotpants"], weak: ["short"] },
  "Jacken & Mäntel": {
    strong: ["~jacke", "~jacken", "jacket", "jackets", "~mantel", "~maentel", "coat", "~coat", "coats", "~parka", "parkas", "~blazer",
      "~weste", "~westen", "vest", "gilet", "~anorak", "~sakko", "veste", "windbreaker", "bomber", "trench", "puffer"],
    weak: ["daunen", "steppjacke"],
  },
  "Pullover & Hoodies": {
    strong: ["~pullover", "~pulli", "~pullis", "~hoodie", "~hoodies", "hoody", "~sweatshirt", "~sweatshirts", "sweater", "sweaters",
      "cardigan", "cardigans", "~strickjacke", "~troyer", "crewneck", "quarterzip", "jumper", "~strickpullover"],
    weak: ["sweat", "fleece", "strick", "knit"],
  },
  "Shirts & Tops": {
    strong: ["~shirt", "~shirts", "~hemd", "~hemden", "~bluse", "~blusen", "tops", "~tanktop", "~croptop", "tee", "tees",
      "polo", "polos", "longsleeve", "longsleeves", "~trikot", "tunika", "~body"],
    // „top“ allein nur schwach – „Top Zustand“ steht in vielen Titeln
    weak: ["top", "crop", "jersey", "oversize"],
  },
  "Kleider & Röcke": {
    strong: ["~kleid", "~kleider", "+rock", "~roecke", "dress", "dresses", "skirt", "skirts", "jumpsuit", "jumpsuits", "overall", "playsuit"],
    weak: ["rock", "midi", "maxi"],
  },
  "Schuhe": {
    strong: ["~schuh", "~schuhe", "shoes", "shoe", "~sneaker", "~sneakers", "~boots", "~stiefel", "~stiefelette", "~stiefeletten",
      "~sandale", "~sandalen", "sandals", "~pantoffel", "~pantoffeln", "~latschen", "~slipper", "pumps", "loafer", "loafers",
      "trainers", "chucks", "clogs", "heels", "espadrilles", "mules", "flipflops", "chaussures", "~ballerinas"],
    weak: ["sohle"],
  },
  "Taschen": {
    strong: ["~tasche", "~taschen", "bag", "~bag", "bags", "handbag", "~rucksack", "backpack", "shopper", "clutch", "~beutel"],
  },
  "Accessoires": {
    strong: ["~guertel", "belt", "belts", "cap", "caps", "~muetze", "~muetzen", "beanie", "~hut", "~huete", "hat", "~schal",
      "scarf", "~uhr", "watch", "~kette", "~armband", "ring", "ringe", "~ohrring", "~ohrringe", "~sonnenbrille", "sunglasses",
      "~handschuh", "~handschuhe", "gloves", "~krawatte", "~schmuck", "~geldboerse", "wallet", "~geldbeutel", "~portemonnaie",
      "~halstuch", "~tuch", "accessoire", "accessoires"],
  },
};
const CATEGORIES = [...Object.keys(CATEGORY_WORDS), "Sonstige"];
const WORD_RULES = Object.entries(CATEGORY_WORDS).flatMap(([category, { strong, weak = [] }]) => [...strong.map((w) => [w, 2]), ...weak.map((w) => [w, 1])].map(([w, weight]) => {
  if (w.startsWith("/"))
    return { category, word: w, mode: "re", weight, re: new RegExp(w.slice(1, -1)) };
  if (w[0] === "~" || w[0] === "+")
    return { category, word: w.slice(1), mode: w[0], weight };
  return { category, word: w, mode: "=", weight };
}));
/** Bester Treffer für ein einzelnes Wort (längstes passendes Stichwort, dann höheres Gewicht). */
function matchToken(tk) {
  let best = null;
  for (const r of WORD_RULES) {
    const ok = r.mode === "=" ? tk === r.word
      : r.mode === "~" ? tk.endsWith(r.word)
        : r.mode === "+" ? tk.length > r.word.length && tk.endsWith(r.word)
          : r.re.test(tk);
    if (!ok)
      continue;
    const len = r.mode === "re" ? tk.length : r.word.length;
    const bestLen = best ? (best.mode === "re" ? tk.length : best.word.length) : -1;
    if (!best || len > bestLen || (len === bestLen && r.weight > best.weight))
      best = r;
  }
  return best;
}
/** Kategorie aus einer Wortliste oder null. */
function categoryFromTokens(tokens) {
  const score = new Map();
  tokens.forEach((tk, i) => {
    const r = matchToken(tk);
    if (!r)
      return;
    const cur = score.get(r.category) || { points: 0, first: i };
    cur.points += r.weight;
    score.set(r.category, cur);
  });
  let best = null, bp = 0, bf = Infinity;
  for (const [cat, { points, first }] of score) {
    if (points > bp || (points === bp && first < bf)) {
      best = cat;
      bp = points;
      bf = first;
    }
  }
  return best;
}
/** Kategorie aus einem Titel (Markennamen wie „Pepe Jeans“ zählen nicht mit). */
function categoryFromTitle(title) {
  const tokens = titleTokens(title);
  const brand = findBrand(tokens);
  return categoryFromTokens(brand ? [...tokens.slice(0, brand.start), ...tokens.slice(brand.end)] : tokens);
}
/** Kategorie aus dem Vinted-Kategoriepfad („Herren › Kleidung › Jeans › Bootcut-Jeans“): tiefstes Glied zuerst. */
function categoryFromPath(path) {
  const parts = String(path || "").split(/›|>|\//).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const c = categoryFromTokens(titleTokens(parts[i]));
    if (c)
      return c;
  }
  return null;
}
/** Kategorie eines Verkaufs mit Herkunft: manuell > Vinted-Kategorie > Titel > „Sonstige“. */
function categoryInfo(e, overrides) {
  const manual = e.id ? overrides?.[e.id] : undefined;
  if (manual && CATEGORIES.includes(manual))
    return { category: manual, source: "manual" };
  const fromPath = e.catalogPath ? categoryFromPath(e.catalogPath) : null;
  if (fromPath)
    return { category: fromPath, source: "vinted" };
  const fromTitle = categoryFromTitle(e.title);
  if (fromTitle)
    return { category: fromTitle, source: "title" };
  return { category: "Sonstige", source: "none" };
}
/** Kategorie aus Titel bzw. Vinted-Pfad (ohne manuelle Korrektur). */
function categoryOf(title, catalogPath) {
  return categoryInfo({ title, catalogPath }).category;
}
/** Umsatz der Verkäufe (Ereignisse) nach Kategorie, absteigend. */
function categoryRevenue(events, overrides) {
  const map = new Map();
  let total = 0;
  for (const e of events) {
    if (e.kind !== "sale")
      continue;
    const c = categoryInfo(e, overrides).category;
    const cur = map.get(c) || { category: c, value: 0, count: 0 };
    cur.value += e.revenue;
    cur.count += 1;
    map.set(c, cur);
    total += e.revenue;
  }
  return { rows: [...map.values()].sort((a, b) => b.value - a.value), total };
}

// Status-Label eines eigenen Angebots.
function listingStatus(l) {
  if (l.reserved) return { label: "Reserviert", color: "var(--p-label)" };
  if (l.draft) return { label: "Entwurf", color: "var(--p-other)" };
  if (l.hidden) return { label: "Versteckt", color: "var(--p-other)" };
  return { label: "Gelistet", color: "var(--p-transit)" };
}

function listingsSummary(listings) {
  return {
    count: listings.length,
    price: listings.reduce((a, b) => a + (b.price || 0), 0),
    views: listings.reduce((a, b) => a + (b.views || 0), 0),
    favourites: listings.reduce((a, b) => a + (b.favourites || 0), 0),
  };
}

const listDateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short", year: "numeric" });
function fmtListingDate(d) {
  const dt = parseDate(d);
  return dt ? listDateFmt.format(dt) : "";
}

// Beste/schlechteste Verkäufe (Ereignisse) nach Gewinn nach Betriebskosten.
function flipRankings(events, n = 3) {
  const sold = events.filter((e) => e.kind === "sale" && e.netProfit != null).sort((a, b) => b.netProfit - a.netProfit);
  if (sold.length <= n * 2) return { single: sold };
  return { best: sold.slice(0, n), worst: sold.slice(-n).reverse() };
}

// ---------- Eigene Käufe (andere Plattformen) ----------

const PLATFORMS = [
  { key: "kleinanzeigen", label: "Kleinanzeigen", short: "KA" },
  { key: "ebay",          label: "eBay",          short: "eBay" },
  { key: "flohmarkt",     label: "Flohmarkt",     short: "Floh" },
  { key: "laden",         label: "Laden",         short: "Laden" },
  { key: "sonstige",      label: "Sonstige",      short: "\u2022" },
];
const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));
function platformLabel(m) {
  if (m.platform === "sonstige") return (m.platformOther || "").trim() || "Sonstige";
  return PLATFORM_BY_KEY[m.platform]?.label || "Eigener Kauf";
}
function platformShort(m) {
  if (m.platform === "sonstige") return ((m.platformOther || "").trim().slice(0, 4)) || "\u2022";
  return PLATFORM_BY_KEY[m.platform]?.short || "\u2022";
}

// Eigener Kauf → gleiches Format wie ein Vinted-Kauf.
function manualToOrder(m) {
  return {
    id: m.id, title: String(m.title || "").trim(), amount: num(m.amount), status: "", userStatus: "",
    date: m.date, photo: m.photo || "", conv: "", source: "manual",
    platform: platformLabel(m), platformShort: platformShort(m),
  };
}

function statusGroups(items) {
  return RESELLER_STATUS
    .map((s) => {
      const list = items.filter((i) => i.rstatus === s.key);
      return { status: s, count: list.length };
    })
    .filter((g) => g.count > 0);
}

// ---------- Speicher: meta (Angaben pro Posten), Zuordnungen und Einstellungen ----------
async function getMeta() {
  const { meta } = await chrome.storage.local.get("meta");
  return meta || {};
}
async function patchMeta(id, patch) {
  const meta = await getMeta();
  meta[id] = { ...(meta[id] || {}), ...patch };
  for (const k of Object.keys(meta[id])) if (meta[id][k] === "" || meta[id][k] == null) delete meta[id][k];
  await chrome.storage.local.set({ meta });
  return meta;
}
async function getSaleLinks() {
  const { saleLinks } = await chrome.storage.local.get("saleLinks");
  return saleLinks || {};
}
// value: purchaseId, "none" (keine Zuordnung) oder null (zurück auf automatisch).
async function setSaleLink(saleId, value) {
  const links = await getSaleLinks();
  if (value == null) delete links[String(saleId)];
  else links[String(saleId)] = String(value);
  await chrome.storage.local.set({ saleLinks: links });
  return links;
}
// Betriebskosten (bleiben beim Test-Button „Daten löschen“ erhalten, wie Einstellungen).
async function getCosts() {
  const { costs } = await chrome.storage.local.get("costs");
  return Array.isArray(costs) ? costs : [];
}
async function saveCost(cost) {
  const costs = await getCosts();
  const idx = costs.findIndex((c) => c.id === cost.id);
  if (idx >= 0) costs[idx] = cost; else costs.push(cost);
  await chrome.storage.local.set({ costs });
  return costs;
}
async function deleteCost(id) {
  const costs = (await getCosts()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ costs });
  return costs;
}
async function getManualOrders() {
  const { manualOrders } = await chrome.storage.local.get("manualOrders");
  return Array.isArray(manualOrders) ? manualOrders : [];
}
async function saveManualOrder(order) {
  const list = await getManualOrders();
  const idx = list.findIndex((o) => o.id === order.id);
  if (idx >= 0) list[idx] = order; else list.push(order);
  await chrome.storage.local.set({ manualOrders: list });
  return list;
}
async function deleteManualOrder(id) {
  const list = (await getManualOrders()).filter((o) => o.id !== id);
  const meta = await getMeta();
  delete meta[id];
  await chrome.storage.local.set({ manualOrders: list, meta });
  return list;
}
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}), columns: { ...DEFAULT_SETTINGS.columns, ...(settings?.columns || {}) } };
}
async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// ======================= Versand & Details (adaptiv) =======================
// Sucht Tracking, Versanddienstleister, Ziel und Fotos in einer beliebig
// verschachtelten Detail-Antwort, ohne die genauen Feldnamen vorauszusetzen.

// Schlüssel, unter denen Profil-/Benutzerbilder liegen – diese Zweige nie nach Fotos durchsuchen.
const PHOTO_SKIP_KEYS = new Set(["buyer", "seller", "user", "photo", "msg_thread", "conversation", "opposite_user"]);

// Nur die eine Hauptgröße eines Foto-Objekts, keine Thumbnail-Varianten.
function mainPhotoUrl(photo) {
  if (!photo || typeof photo !== "object") return null;
  return photo.full_size_url || photo.url || null;
}

function extractDetail(root) {
  const tx = root?.transaction || root;
  const photos = [];
  const seen = new Set();
  const addItem = (item) => {
    for (const ph of item?.photos || []) {
      const url = mainPhotoUrl(ph);
      if (url && !seen.has(url)) { seen.add(url); photos.push(url); }
    }
  };

  // Artikelfotos exakt aus der bekannten Struktur: transaction.order.items[].photos[]
  for (const item of tx?.order?.items || []) addItem(item);
  if (!photos.length && tx?.item) addItem(tx.item);

  // Tracking, Versanddienstleister und Adresse heuristisch suchen,
  // aber Profil-/Benutzerzweige überspringen.
  const addresses = [];
  let tracking = null, carrier = null, trackingUrl = null;

  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;

    const keys = Object.keys(node).map((k) => k.toLowerCase());
    if (["city", "postal_code", "zip", "line1", "address1"].some((k) => keys.includes(k))) addresses.push(node);

    for (const [k, v] of Object.entries(node)) {
      if (PHOTO_SKIP_KEYS.has(k.toLowerCase()) && v && typeof v === "object") continue;
      const kl = k.toLowerCase();
      if (typeof v === "string" && v) {
        if (!tracking && /(^|_)(tracking|track)_?(code|number|no|id)$|trackingcode|track_code|shipment_?tracking/.test(kl) && v.length >= 5 && !/^https?:/i.test(v)) tracking = v;
        if (!trackingUrl && /track.*url|tracking_link|url.*track/.test(kl) && /^https?:/i.test(v)) trackingUrl = v;
        if (!carrier && /(carrier|shipment_?name|delivery_?type|package_?type|shipping_?provider|point_?type|provider_?name)/.test(kl) && !/^https?:/i.test(v) && v.length > 1 && v.length < 60) carrier = v;
      }
      walk(v);
    }
  })(tx);

  const addr = addresses.find((a) => a.city || a.postal_code || a.zip) || addresses[0] || null;
  return { photos, tracking, trackingUrl, carrier, address: addr };
}

function formatAddress(a) {
  if (!a) return null;
  const line = [a.line1 || a.address1 || a.address, [a.postal_code || a.zip, a.city].filter(Boolean).join(" "), a.country || a.country_code]
    .filter(Boolean).join(", ");
  const name = a.name || [a.first_name, a.last_name].filter(Boolean).join(" ") || null;
  return [name, line].filter(Boolean).join(" · ") || null;
}

async function getDetailCache(id) {
  const key = `detail:${id}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || null;
}
function requestDetail(id, conv) {
  chrome.runtime.sendMessage({ type: "loadDetail", id, conv });
}
