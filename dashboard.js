// Große Übersicht – Reseller-Sicht. Laden selbst passiert in background.js.

let purchases = [];
let sales = [];
let listings = [];
let listingsQuery = "";
let meta = {};
let saleLinks = {};
let costs = [];
let manualOrders = [];
let settings = DEFAULT_SETTINGS;
let model = { items: [], events: [], summary: {}, costStats: {} };
let agg = null;
let activeStatus = null;
let query = "";

// Ansicht-Einstellungen pro Browser merken (reine Bequemlichkeit, darf fehlen).
const pref = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + eur.format(Math.abs(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "–" : `${Math.round(v * 100)} %`);
const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
const monthShort = new Intl.DateTimeFormat("de-DE", { month: "short" });
const hhmm = (t) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

// Die fünf Kacheln: zeigen die Summe des Zeitraums (oder des gewählten Balkens)
// und bestimmen, welche Kennzahl das Diagramm zeigt.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const METRICS = [
  { key: "revenue", label: "Umsatz", color: "var(--p-paid)", money: true,
    value: (b) => b.revenue, sub: (b) => plural(b.soldCount, "Verkauf", "Verkäufe") },
  { key: "profit", label: "Gewinn", color: "var(--p-transit)", money: true, signed: true,
    value: (b) => b.profit,
    sub: (b) => (b.costs ? `vor Kosten ${signed(b.grossProfit)}` : b.revenue > 0 && !b.profitMissing ? `Marge ${pct(b.profit / b.revenue)}` : "nach Betriebskosten") },
  { key: "costs", label: "Betriebskosten", color: "var(--p-refund)", money: true,
    value: (b) => b.costs, sub: (b) => (b.soldCount && b.costs ? `Ø ${eur.format(b.costs / b.soldCount)} pro Verkauf` : "pro Verkauf abgezogen") },
  { key: "soldCount", label: "Verkauft", color: "var(--p-listed)",
    value: (b) => b.soldCount, sub: (b) => b.soldCount ? `Stück · Ø ${eur.format(b.revenue / b.soldCount)}` : "Stück" },
  { key: "boughtCount", label: "Gekauft", color: "var(--p-done)",
    value: (b) => b.boughtCount, sub: (b) => b.boughtCount ? `Stück · Ø ${eur.format(b.spent / b.boughtCount)}` : "Stück" },
  { key: "spent", label: "Ausgaben", color: "var(--p-label)", money: true,
    value: (b) => b.spent, sub: (b) => plural(b.boughtCount, "Kauf", "Käufe") },
];
const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));
const fmtValue = (m, v) => (m.money ? (m.signed ? signed(v) : eur.format(v)) : plural(v, "Stück", "Stück"));
const fmtAxis = (m, v) => (m.money ? eur0.format(v) : String(Math.round(v)));

// Das Geschäftsjahr startet immer mit dem laufenden Jahr (wird bewusst nicht gemerkt).
let activeYear = new Date().getFullYear();
const isCurrentYear = () => activeYear === new Date().getFullYear();
let activeRange = RANGES[pref.get("range")] ? pref.get("range") : pref.get("range") === "12m" ? "year" : "30d";
let activeMetric = METRIC_BY_KEY[pref.get("metric")] ? pref.get("metric") : "revenue";
let chartType = pref.get("chartType") === "line" ? "line" : "bar";
let selectedKey = null;

function rebuild() {
  model = resellerModel(purchases, meta, settings, sales, saleLinks, costs);
  render();
}

let activeView = "overview";

function setView(view) {
  activeView = view;
  $("view-overview").hidden = view !== "overview";
  $("view-orders").hidden = view !== "orders";
  $("view-listings").hidden = view !== "listings";
  $("view-inbox").hidden = view !== "inbox";
  $("view-costs").hidden = view !== "costs";
  const hasData = purchases.length > 0 || sales.length > 0 || listings.length > 0;
  $("empty").hidden = hasData || view === "inbox" || view === "costs";
  if (view === "inbox" && !inboxLoaded && !inboxLoading) loadInbox();
  document.querySelectorAll(".nav-item").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
}

function render() {
  const has = purchases.length > 0 || sales.length > 0 || listings.length > 0;
  // Das Postfach ist unabhängig von geladenen Käufen erreichbar.
  $("empty").hidden = has || activeView === "inbox" || activeView === "costs";
  $("view-overview").hidden = (!has || activeView !== "overview");
  $("view-orders").hidden = !has || activeView !== "orders";
  $("view-listings").hidden = !has || activeView !== "listings";
  $("view-inbox").hidden = activeView !== "inbox";
  $("view-costs").hidden = activeView !== "costs";
  $("export").disabled = !purchases.length;
  $("nav-count").textContent = purchases.length ? String(businessList().filter((i) => i.rstatus !== "refund").length) : "";
  $("nav-listings").textContent = listings.length ? String(listings.length) : "";
  renderYearSelect();
  renderOffers();
  renderCosts();
  if (!has) return;

  renderOverview();
  renderFilterbar();
  renderList();
}

// ======================= Übersicht =======================

function renderOverview() {
  agg = aggregate(model.events, activeRange, activeYear);
  if (selectedKey && !agg.buckets.some((b) => b.key === selectedKey)) selectedKey = null;
  renderRangeSeg();
  renderOverviewRange();
  renderTiles();
  renderChart();
  renderInfoPanel();
  renderTodo();
  renderFlips();
  renderBrands();
  renderSplit();
}

function periodLabel() {
  if (agg.monthly) return `Geschäftsjahr ${activeYear}`;
  if (agg.buckets.length < agg.range.days) return `Seit 1. Januar ${activeYear}`;
  return isCurrentYear() ? `Letzte ${agg.range.label}` : `Letzte ${agg.range.label} von ${activeYear}`;
}
const selectedBucket = () => (selectedKey ? agg.buckets.find((b) => b.key === selectedKey) || null : null);
const bucketLabel = (b) => (agg.monthly ? monthFmt.format(b.start) : longDay.format(b.start));
const bucketShort = (b) => (agg.monthly ? monthFmt.format(b.start) : shortDay.format(b.start));

function renderRangeSeg() {
  document.querySelectorAll("#range-seg [data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === activeRange)));
}

function renderOverviewRange() {
  const first = agg.buckets[0].start;
  const last = agg.buckets[agg.buckets.length - 1].start;
  $("overview-range").textContent = agg.monthly
    ? `Geschäftsjahr ${activeYear} · Januar \u2013 Dezember`
    : `${dayFmt.format(first)} – ${dateOnly.format(last)}`;
}

function renderTiles() {
  const sel = selectedBucket();
  const b = sel || agg.total;
  $("tiles").closest(".kpi-card").classList.toggle("is-day", !!sel);
  $("kpi-scope").replaceChildren(sel ? bucketLabel(sel) : periodLabel());
  if (!sel && !isCurrentYear()) $("kpi-scope").append(" · ", el("span", { className: "past", textContent: "abgeschlossenes Jahr" }));
  $("kpi-clear").hidden = !sel;

  $("tiles").replaceChildren(...METRICS.map((m) => {
    const raw = m.value(b) || 0;
    const valueCls = m.signed && raw < 0 ? " neg" : m.signed && raw > 0 ? " pos" : "";
    const tile = el("button", { type: "button", className: "tile" + (m.key === activeMetric ? " is-active" : "") }, [
      el("span", { className: "tile-label", textContent: m.label }),
      el("span", { className: "tile-value" + valueCls, textContent: m.money ? (m.signed ? signed(raw) : eur.format(raw)) : String(raw) }),
      el("span", { className: "tile-sub", textContent: m.sub(b) }),
    ]);
    const accent = el("span", { className: "tile-accent" });
    accent.style.background = m.color;
    tile.prepend(accent);
    tile.setAttribute("aria-pressed", String(m.key === activeMetric));
    tile.title = `${m.label} im Diagramm zeigen`;
    tile.addEventListener("click", () => {
      activeMetric = m.key;
      pref.set("metric", m.key);
      renderTiles();
      renderChart();
    });
    return tile;
  }));

  const note = $("kpi-note");
  note.hidden = !b.profitMissing;
  if (b.profitMissing) {
    note.textContent = `${b.profitMissing === 1 ? "1 Verkauf hat" : `${b.profitMissing} Verkäufe haben`} keinen zugeordneten Kauf, `
      + "der Gewinn zählt nur Verkäufe mit bekanntem Einkaufspreis. Zuordnen kannst du in der Detailansicht eines Kaufs.";
  }
}

// Diagramm: ein Button pro Tag/Monat. Negative Werte (Verlust) gehen unter die Nulllinie.
let chartScale = null;

function renderChart() {
  const m = METRIC_BY_KEY[activeMetric];
  const buckets = agg.buckets;
  const vals = buckets.map((b) => m.value(b) || 0);
  const maxPos = Math.max(0, ...vals);
  const maxNeg = Math.max(0, ...vals.map((v) => -v));
  const span = maxPos + maxNeg || 1;
  const zero = (maxNeg / span) * 100;                 // Nulllinie in % von unten
  const hPct = (v) => (Math.abs(v) / span) * 100;
  const yPct = (v) => zero + (v / span) * 100;        // Punkt in % von unten
  chartScale = { m, vals, yPct, zero };

  $("chart-metric").textContent = `${m.label} pro ${agg.monthly ? "Monat" : "Tag"}`;
  $("chart-hint").textContent = `Balken anklicken für die Zahlen ${agg.monthly ? "des Monats" : "des Tages"}`;
  const panel = $("chart").closest(".chart-panel");
  const n = buckets.length;
  panel.style.setProperty("--bar-gap", n > 45 ? "1px" : n > 20 ? "3px" : "8px");

  const chartEl = $("chart");
  chartEl.classList.toggle("is-line", chartType === "line");
  chartEl.classList.toggle("dense", n > 45);
  chartEl.classList.toggle("has-selection", !!selectedKey);
  chartEl.setAttribute("aria-label", `${m.label}, ein Balken pro ${agg.monthly ? "Monat" : "Tag"}. Pfeiltasten zum Wechseln, Enter zum Auswählen.`);

  const focusKey = selectedKey || buckets[n - 1].key;
  chartEl.replaceChildren(...buckets.map((b, idx) => {
    const v = vals[idx];
    const col = el("button", { type: "button", className: "chart-col" + (b.key === selectedKey ? " is-selected" : "") });
    col.tabIndex = b.key === focusKey ? 0 : -1;
    col.dataset.key = b.key;
    col.dataset.idx = String(idx);
    col.setAttribute("aria-label", `${bucketLabel(b)}: ${fmtValue(m, v)}`);
    col.setAttribute("aria-pressed", String(b.key === selectedKey));
    const bar = el("span", { className: "chart-bar" + (v < 0 ? " neg" : "") + (v === 0 ? " zero" : "") });
    bar.style.background = m.color;
    bar.style.height = v === 0 ? "2px" : `${hPct(v)}%`;
    bar.style.bottom = `${v >= 0 ? zero : zero - hPct(v)}%`;
    const pt = el("span", { className: "chart-dot" });
    pt.style.background = m.color;
    pt.style.top = `${100 - yPct(v)}%`;
    col.append(bar, pt);
    return col;
  }));

  // Linie (nur im Linienmodus) über den Spaltenmitten.
  const lineEl = $("chart-line");
  if (chartType === "line") {
    const pts = vals.map((v, i) => `${(((i + 0.5) / n) * 100).toFixed(3)},${(100 - yPct(v)).toFixed(3)}`).join(" ");
    const base = (100 - zero).toFixed(3);
    lineEl.innerHTML =
      `<svg viewBox="0 0 100 100" preserveAspectRatio="none">` +
      `<polygon points="${(0.5 / n * 100).toFixed(3)},${base} ${pts} ${((n - 0.5) / n * 100).toFixed(3)},${base}" style="fill:${m.color};opacity:.14"/>` +
      `<polyline points="${pts}" style="fill:none;stroke:${m.color}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` +
      `</svg>`;
  } else {
    lineEl.replaceChildren();
  }

  // Hilfslinien mit Beschriftung: Maximum, Hälfte, Null (und Minimum bei Verlusten).
  const lines = [];
  if (maxPos > 0) lines.push({ v: maxPos, label: fmtAxis(m, maxPos) }, { v: maxPos / 2, label: m.money || maxPos >= 2 ? fmtAxis(m, maxPos / 2) : "" });
  lines.push({ v: 0, zero: true, label: maxPos === 0 && maxNeg === 0 ? fmtAxis(m, 0) : "" });
  if (maxNeg > 0) lines.push({ v: -maxNeg, label: fmtAxis(m, -maxNeg) });
  $("chart-grid").replaceChildren(...lines.map((l) => {
    const line = el("div", { className: "grid-line" + (l.zero ? " zero" : "") });
    line.style.top = `${100 - yPct(l.v)}%`;
    if (l.label) line.append(el("span", { className: "grid-label", textContent: l.label }));
    return line;
  }));

  // Achse: wenige Datumslabels, an „heute“ ausgerichtet.
  const every = agg.monthly || n <= 7 ? 1 : n <= 30 ? 5 : 15;
  $("chart-axis").replaceChildren(...buckets.map((b, idx) => {
    const show = (n - 1 - idx) % every === 0;
    const text = !show ? "" : agg.monthly ? monthShort.format(b.start) : n <= 7 ? shortDay.format(b.start) : dayFmt.format(b.start);
    return el("span", { className: "axis-tick", textContent: text });
  }));

  const peakIdx = vals.reduce((best, v, i) => (v > vals[best] ? i : best), 0);
  $("chart-foot").textContent = vals[peakIdx] > 0
    ? `Stärkster ${agg.monthly ? "Monat" : "Tag"}: ${bucketShort(buckets[peakIdx])} · ${fmtValue(m, vals[peakIdx])}`
    : `Keine Werte für „${m.label}“ in diesem Zeitraum.`;

  hideTip();
}

function selectBucket(key) {
  selectedKey = selectedKey === key ? null : key;
  renderTiles();
  const chartEl = $("chart");
  chartEl.classList.toggle("has-selection", !!selectedKey);
  chartEl.querySelectorAll(".chart-col").forEach((c) => {
    const on = c.dataset.key === selectedKey;
    c.classList.toggle("is-selected", on);
    c.setAttribute("aria-pressed", String(on));
  });
}

function showTip(col) {
  if (!chartScale) return;
  const idx = Number(col.dataset.idx);
  const b = agg.buckets[idx];
  const { m, vals, yPct, zero } = chartScale;
  const tip = $("chart-tip");
  tip.replaceChildren(el("strong", { textContent: bucketShort(b) }), fmtValue(m, vals[idx]));
  tip.hidden = false;
  const area = $("chart").parentElement;
  const top = area.clientHeight * (1 - Math.max(yPct(vals[idx]), zero) / 100) - 8;
  let left = col.offsetLeft + col.offsetWidth / 2;
  const half = tip.offsetWidth / 2;
  left = Math.max(half, Math.min(area.clientWidth - half, left));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(tip.offsetHeight, top)}px`;
}
function hideTip() { $("chart-tip").hidden = true; }

$("chart").addEventListener("click", (e) => {
  const col = e.target.closest(".chart-col");
  if (col) selectBucket(col.dataset.key);
});
$("chart").addEventListener("mouseover", (e) => {
  const col = e.target.closest(".chart-col");
  if (col) showTip(col);
});
$("chart").addEventListener("mouseleave", hideTip);
$("chart").addEventListener("focusin", (e) => {
  const col = e.target.closest(".chart-col");
  if (col) showTip(col);
});
$("chart").addEventListener("focusout", hideTip);
$("chart").addEventListener("keydown", (e) => {
  const col = e.target.closest(".chart-col");
  if (!col) return;
  if (e.key === "Escape" && selectedKey) { e.preventDefault(); selectBucket(selectedKey); return; }
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
  if (step == null) return;
  e.preventDefault();
  const cols = [...$("chart").querySelectorAll(".chart-col")];
  const next = cols[Math.max(0, Math.min(cols.length - 1, Number(col.dataset.idx) + step))];
  col.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
});
$("kpi-clear").addEventListener("click", () => { if (selectedKey) selectBucket(selectedKey); });

document.querySelectorAll("#range-seg [data-range]").forEach((b) => b.addEventListener("click", () => {
  activeRange = b.dataset.range;
  pref.set("range", activeRange);
  selectedKey = null;
  renderOverview();
}));

function setChartType(t) {
  chartType = t;
  pref.set("chartType", t);
  $("ct-bar").setAttribute("aria-pressed", String(t === "bar"));
  $("ct-line").setAttribute("aria-pressed", String(t === "line"));
  if (agg) renderChart();
}
$("ct-bar").addEventListener("click", () => setChartType("bar"));
$("ct-line").addEventListener("click", () => setChartType("line"));

function renderSplit() {
  const { rows, total } = categoryRevenue(agg.events);
  $("donut-total").textContent = eur.format(total);
  const palette = ["var(--p-done)", "var(--p-paid)", "var(--p-transit)", "var(--p-label)", "var(--p-listed)", "var(--p-other)"];
  const svg = $("donut-svg");
  const R = 54, C = 60, circ = 2 * Math.PI * R;
  if (!rows.length || total === 0) {
    svg.innerHTML = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--line)" stroke-width="12"/>`;
    $("split").replaceChildren(el("li", { className: "split-empty", textContent: "Keine Verkäufe in diesem Zeitraum." }));
    return;
  }
  let offset = 0;
  const segs = rows.map((r, idx) => {
    const frac = r.value / total;
    const len = frac * circ;
    const color = palette[idx % palette.length];
    const c = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" style="stroke:${color}" stroke-width="12"
      stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${C} ${C})" />`;
    offset += len;
    return c;
  }).join("");
  svg.innerHTML = segs;
  $("split").replaceChildren(...rows.map((r, idx) => {
    const share = Math.round((r.value / total) * 100);
    return el("li", { className: "split-row" }, [
      el("span", { className: "split-name" }, [dot(palette[idx % palette.length]), `${r.category} (${r.count})`]),
      el("span", { className: "split-value", textContent: eur.format(r.value) }),
      el("span", { className: "split-share", textContent: `${share} %` }),
    ]);
  }));
}

function renderTodo() {
  const s = model.summary;
  const items = model.items.filter((i) => !i.private);
  const now = Date.now();
  const staleDays = 14;
  // Unterwegs = noch zu empfangen; Lager/Gelistet lange nach dem Kauf noch unverkauft = prüfen.
  const toReceive = items.filter((i) => i.rstatus === "transit").length;
  const stale = items.filter((i) => (i.rstatus === "stock" || i.rstatus === "listed")
    && (now - (parseDate(i.date) || now)) / 86400000 >= staleDays).length;
  const problems = s.countProblem || 0;
  // Nur offene Punkte des laufenden Jahres; Vorjahre sind abgeschlossen.
  const unlinked = aggregate(model.events, "year", new Date().getFullYear()).total.profitMissing;

  const rows = [];
  if (toReceive) rows.push(["▢", "Unterwegs zu dir", "Sendungen, die noch nicht angekommen sind", toReceive, "transit"]);
  if (stale) rows.push(["⧖", "Lange unverkauft", `Vor über ${staleDays} Tagen gekauft und noch nicht verkauft`, stale, "stock"]);
  if (problems) rows.push(["⚠", "Probleme prüfen", "Käufe mit einem Problem", problems, "problem"]);
  if (unlinked) rows.push(["?", "Verkäufe ohne Einkaufspreis", "Im Kauf zuordnen, damit der Gewinn stimmt", unlinked, null]);
  if (!rows.length) rows.push(["✓", "Alles erledigt", "Keine offenen Punkte gerade.", null, null]);

  $("todo").replaceChildren(...rows.map(([ico, title, sub, count, statusKey]) => {
    const li = el("li", { className: "todo-row" + (statusKey ? " is-link" : "") }, [
      el("span", { className: "todo-ico", textContent: ico, "aria-hidden": "true" }),
      el("span", { className: "todo-text" }, [
        el("span", { className: "todo-title", textContent: title }),
        el("span", { className: "todo-sub", textContent: sub, title: sub }),
      ]),
      count != null ? el("span", { className: "todo-count", textContent: String(count) }) : el("span"),
    ]);
    if (statusKey) {
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      const go = () => { activeStatus = statusKey; showCurrentYear(); setView("orders"); renderFilterbar(); renderList(); };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }
    return li;
  }));
}

function renderBrands() {
  const { rows, total } = brandBreakdown(agg.events);
  $("brands-count").textContent = String(rows.length);
  $("brands-total").textContent = eur.format(total);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const palette = ["var(--p-done)", "var(--p-paid)", "var(--p-transit)", "var(--p-listed)", "var(--p-label)", "var(--p-refund)", "var(--p-other)"];
  if (!rows.length) {
    $("brands").replaceChildren(el("li", { className: "split-empty", textContent: "Keine Käufe in diesem Zeitraum." }));
    return;
  }
  $("brands").replaceChildren(...rows.slice(0, 8).map((r, idx) => {
    const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
    const fill = el("span", { className: "brand-fill" });
    fill.style.width = `${Math.round((r.value / max) * 100)}%`;
    fill.style.background = palette[idx % palette.length];
    return el("li", { className: "brand-row" }, [
      el("span", { className: "brand-name-cell", title: `${r.brand} · ${plural(r.count, "Kauf", "Käufe")}` }, [dot(palette[idx % palette.length]), `${r.brand} (${r.count})`]),
      el("span", { className: "brand-track" }, [fill]),
      el("span", { className: "brand-value" }, [
        el("span", { className: "brand-amount", textContent: eur.format(r.value) }),
        el("span", { className: "brand-share", textContent: `${share} %` }),
      ]),
    ]);
  }));
}

function renderOffers() {
  const q = listingsQuery.trim().toLowerCase();
  const rows = listings.filter((l) => !q || l.title.toLowerCase().includes(q) || (l.brand || "").toLowerCase().includes(q));
  $("offers-empty").hidden = listings.length > 0;
  $("offers").parentElement.hidden = listings.length === 0;

  const eye = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const heart = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';

  $("offers").replaceChildren(...rows.map((l) => {
    const st = listingStatus(l);
    const img = el("img", { className: "offer-thumb", alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
    if (l.photo) img.src = l.photo;
    img.addEventListener("error", () => img.removeAttribute("src"));

    const stat = (svg, n) => { const s = el("span", { className: "offer-stat" }); s.innerHTML = svg; s.append(el("span", { textContent: String(n) })); return s; };
    const sub = [l.brand, l.size ? `Größe ${l.size}` : ""].filter(Boolean).join(" · ");

    return el("li", { className: "offer" }, [
      img,
      el("div", { className: "offer-main" }, [
        el("div", { className: "offer-title", textContent: l.title, title: l.title }),
        sub ? el("div", { className: "offer-sub", textContent: sub }) : null,
        el("div", { className: "offer-meta" }, [
          l.login ? el("span", { className: "offer-acc", textContent: `@${l.login}` }) : null,
          stat(eye, l.views),
          stat(heart, l.favourites),
          l.date ? el("span", { className: "offer-date", textContent: fmtListingDate(l.date) }) : null,
        ]),
      ]),
      el("span", { className: "offer-status" }, [dot(st.color), st.label]),
      el("span", { className: "offer-price", textContent: `${eur.format(l.price)}` }),
      el("a", { className: "offer-open", href: l.url, target: "_blank", rel: "noreferrer", title: "Auf Vinted öffnen", textContent: "↗" }),
    ]);
  }));

  const s = listingsSummary(rows);
  $("offers-foot").replaceChildren(
    el("div", { className: "foot-cell" }, [el("span", { className: "foot-num", textContent: String(s.count) }), el("span", { className: "foot-lbl", textContent: "Angebote in der Ansicht" })]),
    el("div", { className: "foot-cell" }, [el("span", { className: "foot-lbl", textContent: "Angebotspreis" }), el("span", { className: "foot-num", textContent: eur.format(s.price) })]),
    el("div", { className: "foot-cell" }, [el("span", { className: "foot-lbl", textContent: "Aufrufe" }), el("span", { className: "foot-num", textContent: s.views.toLocaleString("de-DE") })]),
    el("div", { className: "foot-cell" }, [el("span", { className: "foot-lbl", textContent: "Favoriten" }), el("span", { className: "foot-num", textContent: s.favourites.toLocaleString("de-DE") })]),
  );
}

// Käufe des gewählten Geschäftsjahres (inkl. Bestand aus Vorjahren im laufenden Jahr).
function yearList() {
  return model.items.filter((i) => itemInYear(i, activeYear));
}
// Geschäftliche Käufe des Jahres (private sind nur unter „Privat“ sichtbar).
const businessList = () => yearList().filter((i) => !i.private);
const privateList = () => yearList().filter((i) => i.private);

// Foto oder – bei eigenen Käufen ohne Foto – ein Platzhalter mit Plattform-Kürzel.
function thumbFor(o, className) {
  if (!o.photo && o.platformShort) {
    return el("span", { className: `thumb-ph ${className || ""}`, textContent: o.platformShort, title: o.platform || "" });
  }
  const t = thumb(o);
  if (className) t.className = className;
  return t;
}

function renderFilterbar() {
  const groups = statusGroups(businessList());
  const chip = (key, label, count) => {
    const active = activeStatus === key || (key === null && activeStatus === null);
    const b = el("button", { type: "button", className: "fchip" + (active ? " is-active" : ""), textContent: count == null ? label : `${label} ${count}` });
    b.setAttribute("aria-pressed", String(active));
    b.addEventListener("click", () => { activeStatus = key; renderFilterbar(); renderList(); });
    return b;
  };
  $("filterbar").replaceChildren(
    chip(null, "Alle", businessList().length),
    ...groups.map((g) => chip(g.status.key, g.status.label, g.count)),
  );
  // Immer zeigen (auch mit 0), damit man die Kategorie findet.
  const b = chip("private", "\u{1F512} Privat", privateList().length);
  b.classList.add("is-private");
  $("filterbar").append(b);
}

function renderInfoPanel() {
  const s = model.summary;
  $("info-big").textContent = eur.format(s.stockValue);
  renderStatus();
  const parts = [
    s.sellThrough != null ? `Verkaufsquote ${pct(s.sellThrough)}` : null,
    s.avgHold != null ? `Ø ${Math.round(s.avgHold)} Tage bis Verkauf` : null,
  ].filter(Boolean);
  $("info-note").textContent = parts.join("  ·  ");
  $("info-note").hidden = !parts.length;
}

function renderFlips() {
  const r = flipRankings(agg.events);
  const any = r.single ? r.single.length : (r.best.length + r.worst.length);
  if (!any) {
    $("flips").replaceChildren(el("p", { className: "split-empty", textContent: "Keine Verkäufe mit bekanntem Einkaufspreis in diesem Zeitraum." }));
    return;
  }

  const col = (title, arr) => el("div", { className: "flip-col" }, [
    title ? el("h4", { textContent: title }) : null,
    el("ol", { className: "flip-list" }, arr.map((e) => {
      const t = thumbFor(e.item ? { ...e, platformShort: e.item.platformShort, platform: e.item.platform } : e, "flip-thumb");
      const li = el("li", {}, [
        t,
        el("span", { className: "flip-title", textContent: e.title, title: e.title }),
        el("span", { className: `profit ${e.netProfit < 0 ? "neg" : "pos"}`, textContent: signed(e.netProfit), title: e.costs ? `vor Kosten ${signed(e.profit)}, Betriebskosten ${eur.format(e.costs)}` : "" }),
      ]);
      if (e.item) {
        li.classList.add("is-link");
        li.addEventListener("click", () => openDetail(e.item.id));
      }
      return li;
    })),
  ]);

  if (r.single) $("flips").replaceChildren(col(null, r.single));
  else $("flips").replaceChildren(col("Beste", r.best), col("Schlechteste", r.worst));
}

function renderStatus() {
  // Aktueller Stand im laufenden Jahr: Bestand (auch aus Vorjahren) + was dieses Jahr verkauft/erstattet wurde.
  const items = model.items.filter((i) => !i.private && itemInYear(i, new Date().getFullYear()));
  const groups = statusGroups(items);
  $("bar").replaceChildren(...groups.map((g) => {
    const seg = el("span");
    seg.style.flexGrow = String(g.count);
    seg.style.background = g.status.color;
    return seg;
  }));
  // Summe je Status (für die rechte Werteanzeige).
  const sumByStatus = {};
  for (const i of items) sumByStatus[i.rstatus] = (sumByStatus[i.rstatus] || 0) + i.cost;

  $("legend").replaceChildren(...groups.map((g) => {
    const st = g.status;
    const btn = el("button", { type: "button", className: "info-row" }, [
      dot(st.color),
      el("span", { className: "info-row-label", textContent: st.label }),
      el("span", { className: "info-row-count", textContent: String(g.count) }),
      el("span", { className: "info-row-value", textContent: eur.format(sumByStatus[st.key] || 0) }),
    ]);
    btn.title = `Käufe mit Status „${st.label}“ anzeigen`;
    btn.addEventListener("click", () => {
      activeStatus = st.key;
      showCurrentYear();
      setView("orders");
      renderFilterbar();
      renderList();
    });
    return el("li", {}, [btn]);
  }));
}

// ======================= Käufe-Liste & Detail =======================

function renderList() {
  const q = query.trim().toLowerCase();
  const showPrivate = activeStatus === "private";
  $("private-note").hidden = !showPrivate;
  const visible = (showPrivate ? privateList() : businessList()).filter((i) =>
    (showPrivate || !activeStatus || i.rstatus === activeStatus) && (!q || i.title.toLowerCase().includes(q)));
  $("orders-title").textContent = isCurrentYear() ? `Käufe ${activeYear}` : `Käufe ${activeYear} (abgeschlossen)`;

  $("list").replaceChildren(...visible.map((i) => {
    const st = STATUS_BY_KEY[i.rstatus];
    const right = i.netProfit != null
      ? el("span", { className: `profit ${i.netProfit < 0 ? "neg" : "pos"}`, textContent: signed(i.netProfit) })
      : el("span", { className: "price", textContent: eur.format(i.amount) });

    const when = parseDate(i.date);
    const source = i.source === "manual" ? i.platform : (i.status || "\u2013");
    const row = el("li", { className: `item${i.rstatus === "refund" ? " is-refund" : ""}${i.private ? " is-private" : ""}`, tabIndex: 0 }, [
      thumbFor(i),
      el("div", {}, [
        el("div", { className: "title", textContent: i.title, title: i.title }),
        el("div", { className: "meta", textContent: `${when ? (i.source === "manual" ? dateOnly : dateFmt).format(when) : ""} \u00b7 ${source}` }),
      ]),
      i.private
        ? el("span", { className: "chip", textContent: "\u{1F512} Privat" })
        : el("span", { className: "chip" }, [dot(st.color), i.sale ? `${st.label} (Vinted)` : st.label]),
      i.private ? el("span", { className: "price", textContent: eur.format(i.amount) }) : right,
    ]);
    row.setAttribute("role", "button");
    const open = () => openDetail(i.id);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return row;
  }));
  $("list").hidden = visible.length === 0;
  $("no-match").hidden = visible.length !== 0;
}

// Vinted-Verkäufe, die zu diesem Kauf passen könnten (für die Zuordnung).
function saleCandidates(i) {
  const pt = tokenize(i.title);
  const pd = parseDate(i.date);
  const owner = new Map();
  for (const it of model.items) if (it.sale) owner.set(String(it.sale.id), it);
  const after = sales.filter((s) => { const sd = parseDate(s.date); return !pd || !sd || sd >= pd; });
  const scored = after.map((s) => ({ s, score: titleScore(pt, tokenize(s.title)), owner: owner.get(String(s.id)) || null }));
  const matching = scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
  const shown = new Set(matching.map((c) => c.s.id));
  const others = scored.filter((c) => !shown.has(c.s.id)).slice(0, 60);
  // Den aktuell zugeordneten Verkauf immer anbieten, auch wenn er nicht mehr passt.
  if (i.sale && !scored.some((c) => String(c.s.id) === String(i.sale.id))) others.unshift({ s: i.sale, score: 0, owner: i });
  return { matching, others };
}

function openDetail(id) {
  const i = model.items.find((x) => String(x.id) === String(id));
  if (!i) return;
  const st = STATUS_BY_KEY[i.rstatus];

  const card = $("detail-card");
  card.replaceChildren(
    el("div", { className: "modal-head" }, [
      el("h2", { textContent: "Artikel" }),
      el("button", { type: "button", className: "icon-btn", textContent: "×", title: "Schließen", onclick: () => $("detail").close() }),
    ]),
    el("div", { className: "detail-top" }, [
      thumbFor(i, "detail-photo"),
      el("div", {}, [
        el("div", { className: "detail-title", textContent: i.title }),
        i.source === "manual"
          ? el("div", { className: "meta", textContent: `Gekauft am ${dateOnly.format(parseDate(i.date))} über ${i.platform}` })
          : el("div", { className: "meta", textContent: `Gekauft am ${dateFmt.format(new Date(i.date))}` }),
        i.source === "manual" ? null : el("div", { className: "meta", textContent: `Vinted-Status: ${i.status || "\u2013"}` }),
        i.private
          ? el("div", { className: "chip", style: "margin-top:6px", textContent: "\u{1F512} Privat" })
          : el("div", { className: "chip", style: "margin-top:6px" }, [dot(st.color), st.label]),
      ]),
    ]),
  );

  if (i.source === "manual") {
    const own = manualOrders.find((o) => o.id === i.id);
    card.append(el("div", { className: "detail-actions" }, [
      el("button", { type: "button", className: "btn", textContent: "Eintrag bearbeiten", onclick: () => { $("detail").close(); openManualDialog(own); } }),
    ]));
  }

  if (i.rstatus === "refund") {
    card.append(el("p", { className: "hint", textContent: "Dieser Kauf wurde erstattet und zählt nicht zu Investition oder Gewinn." }));
    $("detail").showModal();
    return;
  }

  // --- Privat: nur zur Ansicht, zählt nirgends ---
  const privateCb = el("input", { type: "checkbox", checked: i.private });
  const privateBox = el("label", { className: "switch private-switch detail-private" }, [
    privateCb, el("span", {}, [el("strong", { textContent: "Privat" }), " – wird nirgends mitgerechnet, nur unter „Privat“ sichtbar"]),
  ]);
  const privateBanner = el("p", { className: "private-banner", textContent: "Dieser Kauf ist privat. Er zählt nicht zu Umsatz, Ausgaben, Gewinn oder Lager und erscheint nicht in der Übersicht." });

  const costLine = el("p", { className: "detail-cost" });
  const profitLine = el("p", { className: "detail-profit", hidden: true });

  // --- Zuordnung zu einem Vinted-Verkauf ---
  const { matching, others } = saleCandidates(i);
  const saleById = new Map(sales.map((s) => [String(s.id), s]));
  const optLabel = (c) => {
    const d = parseDate(c.s.date);
    const taken = c.owner && String(c.owner.id) !== String(i.id) ? " · gehört gerade zu einem anderen Kauf" : "";
    return `${d ? dateOnly.format(d) : "?"} · ${eur.format(c.s.amount)} · ${c.s.title}${taken}`;
  };
  const current = i.sale ? String(i.sale.id) : "";
  const linkSel = el("select", {}, [
    el("option", { value: "", textContent: "Kein Vinted-Verkauf (selbst eintragen)" }),
    matching.length ? el("optgroup", { label: "Passende Titel" }, matching.map((c) => el("option", { value: String(c.s.id), textContent: optLabel(c) }))) : null,
    others.length ? el("optgroup", { label: "Weitere Verkäufe nach dem Kaufdatum" }, others.map((c) => el("option", { value: String(c.s.id), textContent: optLabel(c) }))) : null,
  ]);
  linkSel.value = current;
  const linkHint = el("p", { className: "hint", textContent: i.sale
    ? (i.saleAuto ? "Automatisch über den Titel zugeordnet. Stimmt das nicht, wähle einen anderen Verkauf oder „Kein Vinted-Verkauf“." : "Von dir zugeordnet.")
    : sales.length ? "Wähle den Vinted-Verkauf dieses Artikels, dann werden Verkaufspreis, -datum und Gewinn automatisch übernommen." : "Noch keine Vinted-Verkäufe geladen." });
  const linkBox = el("div", { className: "sale-link" }, [el("label", {}, ["Vinted-Verkauf", linkSel]), linkHint]);

  // --- Manuelle Angaben ---
  const manualSet = meta[i.id]?.status || "";
  const manualSale = meta[i.id]?.salePrice ?? "";
  const manualSold = meta[i.id]?.soldDate ?? "";
  const autoLabel = STATUS_BY_KEY[i.source === "manual" ? "stock" : autoStatus(i.phase)]?.label || "automatisch";
  const statusSel = el("select", {}, [
    el("option", { value: "", textContent: `Automatisch (${autoLabel})` }),
    ...RESELLER_STATUS.filter((s) => s.manual).map((s) => el("option", { value: s.key, textContent: s.label })),
  ]);
  statusSel.value = manualSet;
  const saleInput = el("input", { type: "number", min: "0", step: "0.01", inputMode: "decimal", placeholder: "z. B. 45,00", value: String(manualSale) });
  const extraInput = el("input", { type: "number", min: "0", step: "0.01", inputMode: "decimal", placeholder: num(settings.defaultExtraCost) ? String(num(settings.defaultExtraCost)) : "0", value: (meta[i.id]?.extraCost ?? "") });
  const soldInput = el("input", { type: "date", value: manualSold ? String(manualSold).slice(0, 10) : "" });
  const noteInput = el("textarea", { rows: 2, placeholder: "Notiz (optional)" });
  noteInput.value = i.note || "";

  const form = el("div", { className: "detail-form" }, [
    el("label", {}, ["Status", statusSel]),
    el("label", {}, ["Verkaufspreis (€)", saleInput]),
    el("label", {}, ["Zusatzkosten (€)", extraInput]),
    el("label", {}, ["Verkaufsdatum", soldInput]),
    el("label", { className: "full" }, ["Notiz", noteInput]),
  ]);

  // Mit Vinted-Verkauf kommen Status, Preis und Datum von dort; die Felder sind dann gesperrt.
  const syncLinked = () => {
    const s = saleById.get(linkSel.value) || (i.sale && String(i.sale.id) === linkSel.value ? i.sale : null);
    const linked = !!s;
    for (const f of [statusSel, saleInput, soldInput]) f.disabled = linked;
    if (linked) {
      statusSel.value = "sold";
      saleInput.value = String(s.amount);
      soldInput.value = dayKey(s.date) || "";
    } else {
      statusSel.value = manualSet;
      saleInput.value = String(manualSale);
      soldInput.value = manualSold ? String(manualSold).slice(0, 10) : "";
    }
    recalc();
  };

  const recalc = () => {
    const sale = num(saleInput.value);
    const cost = i.amount + (extraInput.value !== "" ? num(extraInput.value) : num(settings.defaultExtraCost));
    costLine.textContent = `Kaufpreis ${eur.format(i.amount)}  +  Zusatzkosten ${eur.format(cost - i.amount)}  =  Einstand ${eur.format(cost)}`;
    if (!privateCb.checked && statusSel.value === "sold" && saleInput.value !== "") {
      const profit = sale - cost;
      profitLine.textContent = `Gewinn ${signed(profit)}  ·  Rendite ${cost > 0 ? Math.round((profit / cost) * 100) + " %" : "–"}`;
      profitLine.className = `detail-profit ${profit < 0 ? "neg" : "pos"}`;
      profitLine.hidden = false;
    } else {
      profitLine.hidden = true;
    }
  };
  // Trägt man einen Verkaufspreis ein, ohne den Status gesetzt zu haben, auf „Verkauft“ springen.
  saleInput.addEventListener("input", () => { if (saleInput.value !== "" && statusSel.value === "") statusSel.value = "sold"; });
  [statusSel, saleInput, extraInput].forEach((e) => e.addEventListener("input", recalc));
  statusSel.addEventListener("change", () => { if (statusSel.value === "sold" && !soldInput.value) soldInput.value = dayKey(new Date()); });
  linkSel.addEventListener("change", syncLinked);

  const costShare = i.costParts?.length
    ? el("p", { className: "detail-costs", textContent:
        `Betriebskosten-Anteil \u2212${eur.format(i.saleCosts)} (${i.costParts.map((c) => `${c.name} ${eur.format(c.amount)}`).join(", ")})`
        + (i.netProfit != null ? `  \u00b7  Gewinn nach Kosten ${signed(i.netProfit)}` : "") })
    : null;
  card.append(privateBox, privateBanner, costLine, profitLine);
  if (costShare) card.append(costShare);
  card.append(linkBox, form);
  // Privat blendet alles aus, was mit Verkauf und Gewinn zu tun hat.
  const bizOnly = [costLine, profitLine, costShare, linkBox, statusSel.closest("label"), saleInput.closest("label"), soldInput.closest("label")].filter(Boolean);
  const syncPrivate = () => {
    privateBanner.hidden = !privateCb.checked;
    for (const n of bizOnly) n.hidden = privateCb.checked;
    if (!privateCb.checked) recalc();
  };
  privateCb.addEventListener("change", syncPrivate);

  card.append(el("div", { className: "modal-foot" }, [
    el("button", { type: "button", className: "btn", textContent: "Abbrechen", onclick: () => $("detail").close() }),
    el("button", { type: "button", className: "btn btn-primary", textContent: "Speichern", onclick: async () => {
      const isPriv = privateCb.checked;
      const chosen = isPriv ? current : linkSel.value;
      if (chosen !== current) {
        // Alten Verkauf freigeben: bei „kein Verkauf“ ausdrücklich sperren, sonst darf er neu automatisch zugeordnet werden.
        if (current) await setSaleLink(current, chosen ? null : "none");
        if (chosen) await setSaleLink(chosen, i.id);
      }
      const patch = { extraCost: extraInput.value, note: noteInput.value.trim(), private: isPriv ? true : "" };
      if (!chosen && !isPriv) {
        Object.assign(patch, {
          status: statusSel.value,
          salePrice: saleInput.value,
          soldDate: statusSel.value === "sold" && soldInput.value ? soldInput.value : "",
        });
      }
      await patchMeta(i.id, patch);
      [meta, saleLinks] = await Promise.all([getMeta(), getSaleLinks()]);
      $("detail").close();
      rebuild();
    } }),
  ]));

  if (i.source !== "manual") card.append(buildShipSection(i));

  syncLinked();
  syncPrivate();
  $("detail").showModal();
}

// ---------- Versand & Details (pro Bestellung nachladen) ----------

let detailWatch = null;

function buildShipSection(i) {
  const body = el("div", { className: "ship-body" });
  const btn = el("button", { type: "button", className: "btn", textContent: "Von Vinted laden" });
  const section = el("section", { className: "ship" }, [
    el("div", { className: "ship-head" }, [el("h3", { textContent: "Versand & Details" }), btn]),
    body,
  ]);

  const renderState = (state) => {
    if (!state) { body.replaceChildren(el("p", { className: "hint", textContent: "Tracking, Versanddienstleister, Ziel und weitere Fotos werden direkt bei Vinted nachgeladen." })); return; }
    if (state.status === "loading") {
      btn.disabled = true; btn.textContent = "Lädt …";
      body.replaceChildren(el("p", { className: "hint", textContent: "Lade Details …" }));
      return;
    }
    btn.disabled = false; btn.textContent = "Neu laden";
    if (state.status === "error") { body.replaceChildren(el("p", { className: "ship-error", textContent: state.message || "Konnte keine Details laden." })); return; }
    renderDetailData(body, state.data);
  };

  btn.addEventListener("click", () => { btn.disabled = true; requestDetail(i.id, i.conv); });

  // Gecachten Stand zeigen und auf Änderungen horchen, solange der Dialog offen ist.
  getDetailCache(i.id).then(renderState);
  if (detailWatch) chrome.storage.onChanged.removeListener(detailWatch);
  detailWatch = (changes, area) => {
    if (area === "session" && changes[`detail:${i.id}`]) renderState(changes[`detail:${i.id}`].newValue);
  };
  chrome.storage.onChanged.addListener(detailWatch);
  $("detail").addEventListener("close", () => {
    if (detailWatch) { chrome.storage.onChanged.removeListener(detailWatch); detailWatch = null; }
  }, { once: true });

  return section;
}

function renderDetailData(body, data) {
  const d = extractDetail(data);
  const rows = [];
  if (d.tracking) rows.push(["Sendungsnummer", d.trackingUrl
    ? el("a", { href: d.trackingUrl, target: "_blank", rel: "noreferrer", textContent: d.tracking })
    : d.tracking]);
  if (d.carrier) rows.push(["Versanddienstleister", d.carrier]);
  const addr = formatAddress(d.address);
  if (addr) rows.push(["Geliefert an", addr]);

  const children = [];
  if (rows.length) {
    children.push(el("dl", { className: "ship-facts" }, rows.flatMap(([k, v]) =>
      [el("dt", { textContent: k }), el("dd", {}, [v])])));
  }
  if (d.photos.length) {
    children.push(el("div", { className: "gallery" }, d.photos.map((url, idx) => {
      const img = el("img", { src: url, alt: `Foto ${idx + 1}`, loading: "lazy", referrerPolicy: "no-referrer" });
      const btn = el("button", { type: "button", className: "gallery-item", title: "Groß ansehen" }, [img]);
      btn.addEventListener("click", () => openLightbox(d.photos, idx));
      return btn;
    })));
  }
  if (!rows.length && !d.photos.length) {
    children.push(el("p", { className: "hint", textContent: "In der Antwort wurden keine Tracking-/Fotodaten erkannt. Öffne die Rohdaten und schick sie mir, dann ergänze ich die Felder." }));
  }
  const raw = el("details", { className: "raw" }, [
    el("summary", { textContent: "Rohdaten anzeigen" }),
    el("pre", { textContent: JSON.stringify(data, null, 2).slice(0, 20000) }),
  ]);
  children.push(raw);
  body.replaceChildren(...children);
}

// ---------- Foto-Großansicht (im selben Fenster, kein neuer Tab) ----------

let lightboxPhotos = [];
let lightboxIndex = 0;

function showLightboxPhoto() {
  const n = lightboxPhotos.length;
  $("lightbox-img").src = lightboxPhotos[lightboxIndex];
  $("lightbox-count").textContent = `${lightboxIndex + 1} / ${n}`;
  $("lightbox-prev").hidden = n < 2;
  $("lightbox-next").hidden = n < 2;
}

function openLightbox(photos, index) {
  lightboxPhotos = photos;
  lightboxIndex = index;
  showLightboxPhoto();
  const lb = $("lightbox");
  if (!lb.open) lb.showModal();
}

function stepLightbox(delta) {
  if (!lightboxPhotos.length) return;
  lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length;
  showLightboxPhoto();
}

$("lightbox-prev").addEventListener("click", () => stepLightbox(-1));
$("lightbox-next").addEventListener("click", () => stepLightbox(1));
$("lightbox-close").addEventListener("click", () => $("lightbox").close());
$("lightbox").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
});

// ======================= Einstellungen & Export =======================

function openSettings() {
  $("col-grid").replaceChildren(...EXPORT_COLUMNS.map((c) => {
    const cb = el("input", { type: "checkbox", checked: !!settings.columns[c.key] });
    cb.dataset.col = c.key;
    return el("label", { className: "switch" }, [cb, " " + c.label]);
  }));
  $("set-refunds").checked = !!settings.includeRefunds;
  $("set-delim").value = settings.delimiter;
  $("set-decimal").value = settings.decimal;
  $("set-extra").value = num(settings.defaultExtraCost) || "";
  $("settings").showModal();
}

async function saveSettingsFromForm() {
  const columns = {};
  $("col-grid").querySelectorAll("input[data-col]").forEach((cb) => { columns[cb.dataset.col] = cb.checked; });
  settings = {
    columns,
    includeRefunds: $("set-refunds").checked,
    delimiter: $("set-delim").value,
    decimal: $("set-decimal").value,
    defaultExtraCost: num($("set-extra").value),
  };
  await saveSettings(settings);
  $("settings").close();
  rebuild();
}

function exportCsv() {
  const cols = EXPORT_COLUMNS.filter((c) => settings.columns[c.key]);
  const nf = (n) => (n == null ? "" : n.toFixed(2).replace(".", settings.decimal));
  const d = (iso) => { const dt = parseDate(iso); return dt ? dateFmt.format(dt).replace(",", "") : ""; };
  const value = (i, key) => ({
    datum: d(i.date),
    artikel: i.title,
    kaufpreis: nf(i.amount),
    zusatzkosten: nf(i.extra),
    verkaufspreis: i.salePrice != null ? nf(i.salePrice) : "",
    betriebskosten: i.saleCosts ? nf(i.saleCosts) : "",
    gewinn: i.netProfit != null ? nf(i.netProfit) : "",
    rendite: i.netProfit != null && i.cost > 0 ? Math.round((i.netProfit / i.cost) * 100) : "",
    status: STATUS_BY_KEY[i.rstatus].label,
    haltedauer: i.hold != null ? i.hold : "",
    verkaufsdatum: d(i.soldDate),
    phase: i.source === "manual" ? "eigener Kauf" : i.phase,
    statustext: i.source === "manual" ? i.platform : i.status,
    id: i.id,
  }[key]);

  const items = businessList().filter((i) => settings.includeRefunds || i.rstatus !== "refund");
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [cols.map((c) => c.label), ...items.map((i) => cols.map((c) => value(i, c.key)))];
  const csv = "﻿" + rows.map((r) => r.map(cell).join(settings.delimiter)).join("\r\n");
  const a = el("a", {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
    download: `vinted-reseller-${activeYear}-${dayKey(new Date())}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ================= Postfach (Vinted-Chat) =================

let inboxLoaded = false, inboxLoading = false;
let conversations = [];
let inboxQuery = "";
let inboxFilter = "all";
let activeConv = null;
let threadCache = {};

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => {
    void chrome.runtime.lastError; // Service Worker kurz weg → einfach „keine Antwort“
    resolve(r || { ok: false, error: "keine Antwort" });
  }));
}

// Vinted-Inbox tolerant einlesen (Feldnamen können variieren).
function slimConversation(c) {
  const other = c.opposite_user || c.other_user || c.user || {};
  const item = c.item || c.transaction?.item || {};
  return {
    id: c.id || c.conversation_id,
    name: other.login || c.title || "Unbekannt",
    photo: other.photo?.url || other.photo?.thumbnails?.[0]?.url || "",
    itemTitle: item.title || c.subtitle || "",
    itemPhoto: item.photo?.url || (Array.isArray(item.photos) && item.photos[0]?.url) || "",
    snippet: (c.last_message?.body || c.preview || c.body || "").replace(/\s+/g, " ").trim(),
    time: c.updated_at || c.last_message?.created_at || c.created_at || null,
    unread: !!(c.unread || c.is_unread || (c.unread_count > 0)),
    role: c.is_seller || c.seller_id ? "seller" : "buyer",
  };
}

async function loadInbox() {
  if (inboxLoading) return;
  inboxLoading = true;
  $("conv-empty").hidden = true;
  $("conv-list").replaceChildren(el("li", { className: "conv-loading", textContent: "Lade Postfach …" }));
  const r = await bg({ type: "inbox", page: 1 });
  inboxLoading = false;
  if (!r.ok) {
    $("conv-list").replaceChildren();
    $("conv-empty").hidden = false;
    $("conv-empty").textContent = r.error === "nicht angemeldet"
      ? "Du bist bei vinted.de nicht angemeldet. Melde dich an und lade erneut."
      : `Postfach konnte nicht geladen werden (${r.error}).`;
    return;
  }
  inboxLoaded = true;
  const arr = r.data?.conversations || r.data?.inbox || r.data?.items || [];
  conversations = (Array.isArray(arr) ? arr : []).map(slimConversation).filter((c) => c.id);
  renderInboxFilters();
  renderConversations();
  const unread = conversations.filter((c) => c.unread).length;
  $("nav-inbox").textContent = unread ? String(unread) : "";
}

function renderInboxFilters() {
  const defs = [["all", "Alle"], ["unread", "Ungelesen"], ["buyer", "Von Käufern"], ["seller", "An Verkäufer"]];
  $("inbox-filters").replaceChildren(...defs.map(([key, label]) => {
    const b = el("button", { type: "button", className: "fchip" + (inboxFilter === key ? " is-active" : ""), textContent: label });
    b.addEventListener("click", () => { inboxFilter = key; renderInboxFilters(); renderConversations(); });
    return b;
  }));
}

function renderConversations() {
  const q = inboxQuery.trim().toLowerCase();
  const rows = conversations.filter((c) => {
    if (inboxFilter === "unread" && !c.unread) return false;
    if (inboxFilter === "buyer" && c.role !== "buyer") return false;
    if (inboxFilter === "seller" && c.role !== "seller") return false;
    if (q && !(`${c.name} ${c.itemTitle} ${c.snippet}`.toLowerCase().includes(q))) return false;
    return true;
  });
  $("conv-empty").hidden = conversations.length !== 0;
  $("conv-list").replaceChildren(...rows.map((c) => {
    const img = el("img", { className: "conv-thumb", alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
    const src = c.itemPhoto || c.photo;
    if (src) img.src = src;
    img.addEventListener("error", () => img.removeAttribute("src"));
    const li = el("li", { className: "conv" + (activeConv === c.id ? " is-active" : "") + (c.unread ? " is-unread" : ""), tabIndex: 0 }, [
      img,
      el("div", { className: "conv-main" }, [
        el("div", { className: "conv-top" }, [
          el("span", { className: "conv-name", textContent: c.name }),
          c.time ? el("span", { className: "conv-time", textContent: shortDate.format(new Date(c.time)) }) : null,
        ]),
        c.itemTitle ? el("div", { className: "conv-item", textContent: c.itemTitle }) : null,
        el("div", { className: "conv-snip", textContent: c.snippet || "—" }),
      ]),
      c.unread ? el("span", { className: "conv-dot" }) : null,
    ]);
    const open = () => openConversation(c.id);
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return li;
  }));
}

async function openConversation(id) {
  activeConv = id;
  renderConversations();
  $("chat-placeholder").hidden = true;
  $("chat-thread").hidden = false;
  $("thread-body").replaceChildren(el("div", { className: "thread-loading", textContent: "Lade Unterhaltung …" }));
  $("thread-head").textContent = "";
  const r = await bg({ type: "thread", id });
  if (!r.ok) { $("thread-body").replaceChildren(el("div", { className: "thread-error", textContent: `Konnte nicht laden (${r.error}).` })); return; }
  threadCache[id] = r.data;
  renderThread(id);
}

function renderThread(id) {
  const data = threadCache[id];
  const conv = data?.conversation || data || {};
  const meId = conv.current_user_id || conv.user_id;
  const msgs = conv.messages || conv.thread?.messages || [];
  const other = conv.opposite_user || conv.other_user || {};
  $("thread-head").replaceChildren(
    el("span", { className: "thread-name", textContent: other.login || conversations.find((c) => c.id === id)?.name || "Unterhaltung" }),
    conv.item?.title ? el("span", { className: "thread-item", textContent: conv.item.title }) : null,
  );
  $("thread-body").replaceChildren(...(Array.isArray(msgs) ? msgs : []).map((m) => {
    const mine = (m.user_id != null && meId != null && m.user_id === meId) || m.from_current_user || m.mine;
    const when = parseDate(m.created_at || m.created_at_ts);
    return el("div", { className: "bubble " + (mine ? "mine" : "theirs") }, [
      el("div", { className: "bubble-body", textContent: (m.body || m.text || "").trim() }),
      when ? el("div", { className: "bubble-time", textContent: dateFmt.format(when) }) : null,
    ]);
  }));
  const body = $("thread-body"); body.scrollTop = body.scrollHeight;
}

let sending = false;
async function sendReply(e) {
  e.preventDefault();
  if (sending || !activeConv) return;
  const input = $("composer-input");
  const text = input.value.trim();
  if (!text) return;
  const name = conversations.find((c) => c.id === activeConv)?.name || "diesen Kontakt";
  if (!confirm(`Diese Nachricht an ${name} senden?\n\n${text}`)) return;
  sending = true;
  const btn = $("composer-send"); btn.disabled = true; btn.textContent = "Sende …";
  const r = await bg({ type: "send", id: activeConv, body: text });
  sending = false; btn.disabled = false; btn.textContent = "Senden";
  if (!r.ok) { $("composer-hint").textContent = `Senden fehlgeschlagen (${r.error}).`; $("composer-hint").classList.add("err"); return; }
  input.value = ""; input.style.height = "";
  $("composer-hint").classList.remove("err");
  $("composer-hint").textContent = "Gesendet.";
  await openConversation(activeConv); // Verlauf neu laden
}

$("inbox-reload").addEventListener("click", () => { inboxLoaded = false; loadInbox(); });
$("inbox-search").addEventListener("input", (e) => { inboxQuery = e.target.value; renderConversations(); });
$("composer").addEventListener("submit", sendReply);
$("composer-input").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px"; });

// ================= Eigener Kauf (andere Plattformen) =================

let editingManual = null;
let manualPhoto = "";

function fillManualSelects() {
  if (!$("manual-platform").options.length) {
    $("manual-platform").replaceChildren(...PLATFORMS.map((p) => el("option", { value: p.key, textContent: p.label })));
    $("manual-status").replaceChildren(...["transit", "stock", "listed", "sold"].map((k) => el("option", { value: k, textContent: STATUS_BY_KEY[k].label })));
  }
}

function syncManualForm() {
  $("manual-other-wrap").hidden = $("manual-platform").value !== "sonstige";
  $("manual-sold-wrap").hidden = $("manual-status").value !== "sold";
  const p = $("manual-photo-preview");
  p.hidden = !manualPhoto;
  if (manualPhoto) p.src = manualPhoto; else p.removeAttribute("src");
  $("manual-photo-remove").hidden = !manualPhoto;
}

function openManualDialog(o = null) {
  fillManualSelects();
  editingManual = o;
  const m = o ? meta[o.id] || {} : {};
  $("manual-title").textContent = o ? "Eigenen Kauf bearbeiten" : "Eigener Kauf";
  $("manual-delete").hidden = !o;
  $("manual-error").hidden = true;
  $("manual-name").value = o?.title || "";
  $("manual-amount").value = o ? String(o.amount) : "";
  $("manual-date").value = o?.date || dayKey(new Date());
  $("manual-platform").value = o?.platform || "kleinanzeigen";
  $("manual-other").value = o?.platformOther || "";
  $("manual-status").value = m.status && ["transit", "stock", "listed", "sold"].includes(m.status) ? m.status : "stock";
  $("manual-extra").value = m.extraCost ?? "";
  $("manual-sale").value = m.salePrice ?? "";
  $("manual-sold").value = m.soldDate || "";
  $("manual-note").value = m.note || "";
  $("manual-private").checked = !!m.private;
  $("manual-photo").value = "";
  manualPhoto = o?.photo || "";
  document.querySelectorAll("#manual-form input").forEach((i) => i.removeAttribute("aria-invalid"));
  syncManualForm();
  $("manual-dialog").showModal();
  $("manual-name").focus();
}

// Foto im Browser auf max. 600 px verkleinern und als JPEG speichern.
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
  const canvas = el("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

function manualError(msg, input) {
  $("manual-error").textContent = msg;
  $("manual-error").hidden = false;
  if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
}

async function saveManualFromForm(e) {
  e.preventDefault();
  document.querySelectorAll("#manual-form input").forEach((i) => i.removeAttribute("aria-invalid"));
  const title = $("manual-name").value.trim();
  const amount = num($("manual-amount").value);
  const date = $("manual-date").value;
  const platform = $("manual-platform").value;
  const status = $("manual-status").value;
  if (!title) return manualError("Bitte gib einen Titel ein.", $("manual-name"));
  if ($("manual-amount").value === "" || amount < 0) return manualError("Bitte gib den Preis ein.", $("manual-amount"));
  if (!date) return manualError("Bitte gib das Kaufdatum an.", $("manual-date"));
  if (platform === "sonstige" && !$("manual-other").value.trim()) return manualError("Bitte gib an, wo du es gekauft hast.", $("manual-other"));
  if (status === "sold" && $("manual-sale").value === "") return manualError("Bitte gib den Verkaufspreis an.", $("manual-sale"));

  const order = {
    id: editingManual?.id || `m-${crypto.randomUUID()}`,
    title, amount, date, platform,
    platformOther: platform === "sonstige" ? $("manual-other").value.trim() : "",
    photo: manualPhoto,
    createdAt: editingManual?.createdAt || Date.now(),
  };
  try {
    await saveManualOrder(order);
    await patchMeta(order.id, {
      status: status === "stock" ? "" : status, // „Im Lager“ ist ohnehin der Standard
      salePrice: status === "sold" ? $("manual-sale").value : "",
      soldDate: status === "sold" ? ($("manual-sold").value || dayKey(new Date())) : "",
      extraCost: $("manual-extra").value,
      note: $("manual-note").value.trim(),
      private: $("manual-private").checked ? true : "",
    });
  } catch (err) {
    return manualError(`Speichern fehlgeschlagen (${err.message || err}). Versuche es ohne Foto.`);
  }
  $("manual-dialog").close();
  // Privat gespeichert → direkt unter „Privat“ zeigen, sonst in der normalen Liste.
  activeStatus = $("manual-private").checked ? "private" : null;
  if (yearOf(date) <= new Date().getFullYear()) activeYear = yearOf(date);
  meta = await getMeta();
  await loadFromStorage();
  rebuild();
}

$("manual-add").addEventListener("click", () => openManualDialog());
$("manual-form").addEventListener("submit", saveManualFromForm);
$("manual-cancel").addEventListener("click", () => $("manual-dialog").close());
$("manual-close").addEventListener("click", () => $("manual-dialog").close());
$("manual-platform").addEventListener("change", syncManualForm);
$("manual-status").addEventListener("change", () => {
  if ($("manual-status").value === "sold" && !$("manual-sold").value) $("manual-sold").value = dayKey(new Date());
  syncManualForm();
});
$("manual-photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try { manualPhoto = await shrinkPhoto(file); } catch { manualError("Das Bild konnte nicht gelesen werden."); }
  syncManualForm();
});
$("manual-photo-remove").addEventListener("click", () => { manualPhoto = ""; $("manual-photo").value = ""; syncManualForm(); });
$("manual-delete").addEventListener("click", async () => {
  if (!editingManual || !confirm(`„${editingManual.title}“ wirklich löschen?`)) return;
  await deleteManualOrder(editingManual.id);
  $("manual-dialog").close();
  meta = await getMeta();
  await loadFromStorage();
  rebuild();
});

// ================= Geschäftsjahr =================

function renderYearSelect() {
  const years = availableYears(model.events);
  if (!years.includes(activeYear)) activeYear = years[0];
  const sel = $("year-select");
  const want = years.join(",");
  if (sel.dataset.years !== want) {
    sel.replaceChildren(...years.map((y) => el("option", { value: String(y), textContent: String(y) })));
    sel.dataset.years = want;
  }
  sel.value = String(activeYear);
}
$("year-select").addEventListener("change", (e) => {
  activeYear = Number(e.target.value);
  selectedKey = null;
  activeStatus = null;
  render();
});

// „Nächste Schritte“ und „Wo dein Geld steckt“ zeigen den aktuellen Stand → beim Sprung in die Liste aufs laufende Jahr wechseln.
function showCurrentYear() {
  if (isCurrentYear()) return;
  activeYear = new Date().getFullYear();
  selectedKey = null;
  render();
}

// ================= Betriebskosten =================

const monthLabel = (ym) => (ym ? monthFmt.format(parseDate(`${ym}-01`)) : "");
const currentMonth = () => monthKey(new Date());

function costRule(c) {
  if (c.type === "once") {
    return [`${eur.format(num(c.amount))} einmalig`, `${eur.format(num(c.perPiece))} pro Verkauf abbezahlt`];
  }
  const q = Math.round(num(c.qty));
  return q > 0
    ? [`${eur.format(num(c.amount))} / Monat · ${q} Stück`, `= ${eur.format(num(c.amount) / q)} pro Verkauf`]
    : [`${eur.format(num(c.amount))} / Monat`, "auf die Verkäufe des Monats verteilt"];
}

// Status eines Eintrags: { label, color, done, extra (Element) }
function costState(c, st) {
  if (c.type === "once") {
    const total = num(c.amount);
    const rest = st?.remaining ?? total;
    if (rest <= 0 && st?.paidOffAt) {
      return { label: `Abbezahlt am ${dateOnly.format(parseDate(st.paidOffAt))}`, color: "var(--p-transit)", done: true };
    }
    if (c.date && c.date > dayKey(new Date())) return { label: `Startet am ${dateOnly.format(parseDate(c.date))}`, color: "var(--p-other)" };
    const bar = el("div", { className: "cost-progress", title: `${eur.format(total - rest)} von ${eur.format(total)} abbezahlt` }, [el("span")]);
    bar.firstChild.style.width = `${total > 0 ? Math.round(((total - rest) / total) * 100) : 0}%`;
    const per = num(c.perPiece);
    const left = per > 0 ? Math.ceil(Math.round(rest * 100) / Math.round(per * 100)) : null;
    return {
      label: `Noch ${eur.format(rest)} offen`, color: "var(--p-label)",
      extra: [bar, el("span", { className: "muted", textContent: `${eur.format(total - rest)} von ${eur.format(total)}${left != null ? ` · noch ${plural(left, "Verkauf", "Verkäufe")}` : ""}` })],
    };
  }
  const now = currentMonth();
  if (c.end && c.end < now) return { label: `Beendet (bis ${monthLabel(c.end)})`, color: "var(--p-other)", done: true };
  if (c.start > now) return { label: `Startet ${monthLabel(c.start)}`, color: "var(--p-other)" };
  return { label: `Aktiv seit ${monthLabel(c.start)}${c.end ? ` bis ${monthLabel(c.end)}` : ""}`, color: "var(--p-transit)" };
}

function renderCosts() {
  const stats = model.costStats || {};
  const y = String(activeYear);
  const chargedYear = costs.reduce((s, c) => s + (stats[c.id]?.chargedByYear[y] || 0), 0);
  const now = currentMonth();
  const monthlyActive = costs.filter((c) => c.type === "monthly" && c.start <= now && (!c.end || c.end >= now));
  const openOnce = costs.filter((c) => c.type === "once" && (stats[c.id]?.remaining ?? num(c.amount)) > 0);
  const stat = (label, value, sub) => el("div", { className: "cost-stat" }, [
    el("span", { className: "cost-stat-label", textContent: label }),
    el("span", { className: "cost-stat-value", textContent: value }),
    el("span", { className: "cost-stat-sub", textContent: sub }),
  ]);
  $("cost-stats").replaceChildren(
    stat(`Verrechnet ${activeYear}`, eur.format(chargedYear), "vom Gewinn deiner Verkäufe abgezogen"),
    stat("Monatlich aktiv", `${eur.format(monthlyActive.reduce((s, c) => s + num(c.amount), 0))} / Monat`, plural(monthlyActive.length, "Eintrag", "Einträge")),
    stat("Noch abzuzahlen", eur.format(openOnce.reduce((s, c) => s + (stats[c.id]?.remaining ?? num(c.amount)), 0)), plural(openOnce.length, "offene Anschaffung", "offene Anschaffungen")),
  );
  $("cost-stats").hidden = costs.length === 0;
  $("cost-empty").hidden = costs.length > 0;
  $("nav-costs").textContent = costs.length ? String(monthlyActive.length + openOnce.length) : "";

  const row = (c) => {
    const st = stats[c.id];
    const state = costState(c, st);
    const [rule, ruleSub] = costRule(c);
    const li = el("li", { className: "cost-row" + (state.done ? " is-done" : ""), tabIndex: 0 }, [
      el("div", { className: "cost-main" }, [
        el("div", { className: "cost-name", textContent: c.name, title: c.name }),
        c.desc ? el("div", { className: "cost-desc", textContent: c.desc, title: c.desc }) : null,
      ]),
      el("div", { className: "cost-rule" }, [rule, el("small", { textContent: ruleSub })]),
      el("div", { className: "cost-state" }, [el("span", { className: "chip" }, [dot(state.color), state.label]), ...(state.extra || [])]),
      el("div", { className: "cost-year" }, [el("strong", { textContent: eur.format(st?.chargedByYear[y] || 0) }), `in ${activeYear}`]),
    ]);
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `${c.name} bearbeiten`);
    const open = () => openCostDialog(c);
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return li;
  };
  const byName = (a, b) => a.name.localeCompare(b.name, "de");
  const monthly = costs.filter((c) => c.type === "monthly").sort(byName);
  // Einmalige: offene zuerst, abbezahlte unten.
  const once = costs.filter((c) => c.type === "once")
    .sort((a, b) => (stats[a.id]?.paidOffAt ? 1 : 0) - (stats[b.id]?.paidOffAt ? 1 : 0) || byName(a, b));
  $("cost-monthly").replaceChildren(...monthly.map(row));
  $("cost-once").replaceChildren(...once.map(row));
  $("cost-monthly-group").hidden = !monthly.length;
  $("cost-once-group").hidden = !once.length;
}

// ---------- Dialog: Kosten anlegen/bearbeiten ----------

let editingCost = null;
let costType = "monthly";

function setCostType(t) {
  costType = t;
  document.querySelectorAll("#cost-dialog [data-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.type === t)));
  document.querySelectorAll("#cost-dialog [data-for]").forEach((n) => { n.hidden = n.dataset.for !== t; });
  $("cost-amount-label").textContent = t === "once" ? "Kaufpreis (€)" : "Betrag pro Monat (€)";
  $("cost-name").placeholder = t === "once" ? "z. B. Etikettendrucker" : "z. B. Versandtüten";
  costPreview();
}

function costPreview() {
  const amount = num($("cost-amount").value);
  let text = "";
  if (costType === "once") {
    const per = num($("cost-per").value);
    if (amount > 0 && per > 0) text = `Nach ${plural(Math.ceil(Math.round(amount * 100) / Math.round(per * 100)), "Verkauf", "Verkäufen")} abbezahlt. Danach wird nichts mehr abgezogen.`;
  } else if (amount > 0) {
    const q = Math.round(num($("cost-qty").value));
    text = q > 0
      ? `Jeder Verkauf trägt ${eur.format(amount / q)}. Nicht verbrauchter Vorrat wird nicht abgezogen.`
      : "Der Betrag wird jeden Monat auf alle Verkäufe dieses Monats verteilt. Monate ohne Verkauf kosten nichts.";
  }
  $("cost-preview").textContent = text;
}

function openCostDialog(c = null) {
  editingCost = c;
  $("cost-title").textContent = c ? "Kosten bearbeiten" : "Kosten hinzufügen";
  $("cost-delete").hidden = !c;
  $("cost-error").hidden = true;
  $("cost-name").value = c?.name || "";
  $("cost-desc").value = c?.desc || "";
  $("cost-amount").value = c ? String(c.amount) : "";
  $("cost-qty").value = c?.qty ? String(c.qty) : "";
  $("cost-per").value = c?.perPiece ? String(c.perPiece) : "";
  $("cost-start").value = c?.start || currentMonth();
  $("cost-end").value = c?.end || "";
  $("cost-date").value = c?.date || dayKey(new Date());
  document.querySelectorAll("#cost-form input").forEach((i) => i.removeAttribute("aria-invalid"));
  setCostType(c?.type || "monthly");
  $("cost-dialog").showModal();
  $("cost-name").focus();
}

function costError(msg, input) {
  $("cost-error").textContent = msg;
  $("cost-error").hidden = false;
  if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
}

async function saveCostFromForm(e) {
  e.preventDefault();
  document.querySelectorAll("#cost-form input").forEach((i) => i.removeAttribute("aria-invalid"));
  const name = $("cost-name").value.trim();
  const amount = num($("cost-amount").value);
  if (!name) return costError("Bitte gib einen Namen ein.", $("cost-name"));
  if (!(amount > 0)) return costError("Bitte gib einen Betrag größer als 0 ein.", $("cost-amount"));
  const cost = { id: editingCost?.id || crypto.randomUUID(), name, desc: $("cost-desc").value.trim(), type: costType, amount };
  if (costType === "once") {
    const per = num($("cost-per").value);
    if (!(per > 0)) return costError("Bitte gib an, wie viel pro verkauftem Stück abbezahlt wird.", $("cost-per"));
    if (!$("cost-date").value) return costError("Bitte gib das Kaufdatum an.", $("cost-date"));
    Object.assign(cost, { perPiece: per, date: $("cost-date").value });
  } else {
    const start = $("cost-start").value;
    const end = $("cost-end").value;
    if (!start) return costError("Bitte gib den Startmonat an.", $("cost-start"));
    if (end && end < start) return costError("Der Endmonat liegt vor dem Startmonat.", $("cost-end"));
    const qty = Math.round(num($("cost-qty").value));
    Object.assign(cost, { qty: qty > 0 ? qty : null, start, end: end || null });
  }
  costs = await saveCost(cost);
  $("cost-dialog").close();
  rebuild();
}

$("cost-add").addEventListener("click", () => openCostDialog());
$("cost-form").addEventListener("submit", saveCostFromForm);
$("cost-cancel").addEventListener("click", () => $("cost-dialog").close());
$("cost-close").addEventListener("click", () => $("cost-dialog").close());
document.querySelectorAll("#cost-dialog [data-type]").forEach((b) => b.addEventListener("click", () => setCostType(b.dataset.type)));
["cost-amount", "cost-qty", "cost-per"].forEach((id) => $(id).addEventListener("input", costPreview));
$("cost-delete").addEventListener("click", async () => {
  if (!editingCost || !confirm(`„${editingCost.name}“ löschen? Die Kosten werden dann auch rückwirkend nicht mehr abgezogen.`)) return;
  costs = await deleteCost(editingCost.id);
  $("cost-dialog").close();
  rebuild();
});

// ================= Automatische Aktualisierung =================
// Die Übersicht gibt den Takt vor (alle 60 s, im Hintergrund-Tab alle 5 min);
// background.js entscheidet, ob schnell, vollständig oder gar nicht (Pause,
// Wartezeit nach „zu viele Anfragen“, Sicherheitsprüfung, nicht angemeldet).

const AUTO_MS = 60 * 1000;
const HIDDEN_MS = 5 * 60 * 1000;
let autoTimer = null;
let autoPaused = pref.get("autoPaused") === "1";
let syncInfo = {};
let lastUpdatedAt = null;

function scheduleAuto(delay) {
  clearTimeout(autoTimer);
  if (autoPaused) return;
  autoTimer = setTimeout(autoTick, delay);
}

async function autoTick() {
  const r = await bg({ type: "sync" });
  if (r?.sync) syncInfo = r.sync;
  renderLive();
  const base = document.hidden ? HIDDEN_MS : AUTO_MS;
  scheduleAuto(base + (Math.random() * 10000 - 5000));
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - (syncInfo.lastAttempt || 0) > AUTO_MS) scheduleAuto(800);
});

function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "gerade eben";
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  return `um ${hhmm(t)}`;
}

function renderLive() {
  const s = syncInfo || {};
  let state, text;
  let action = null;
  if (s.phase === "running" && s.lockAt) { state = "running"; text = "Aktualisiere …"; }
  else if (s.paused === "auth") { state = "error"; text = "Nicht angemeldet"; action = "Erneut versuchen"; }
  else if (s.paused === "challenge") { state = "warn"; text = "Sicherheitsprüfung nötig"; action = "Jetzt prüfen"; }
  else if (s.backoffUntil && Date.now() < s.backoffUntil) { state = "warn"; text = `Vinted bremst – weiter ${hhmm(s.backoffUntil)}`; }
  else if (autoPaused) { state = "idle"; text = "Automatik pausiert"; }
  else if (s.lastOk) { state = "ok"; text = "Live · alle 60 s"; }
  else { state = "idle"; text = "Automatisch alle 60 s"; }

  $("live").dataset.state = state;
  $("live-text").textContent = text;
  const sub = $("updated");
  const when = s.lastOk || lastUpdatedAt;
  sub.replaceChildren(when ? `Aktualisiert ${relTime(when)}` : "Noch nicht geladen");
  // Hinweis für die Fehlersuche: Die direkte Verbindung war blockiert, dein offener Vinted-Tab hat ausgeholfen.
  if (s.lastOk && s.transport === "tab") sub.append(" · über deinen Vinted-Tab");
  if (action) {
    const b = el("button", { type: "button", textContent: action });
    b.addEventListener("click", requestLoad);
    sub.append(" · ", b);
  }
  const t = $("live-toggle");
  t.textContent = autoPaused ? "Weiter" : "Pause";
  t.setAttribute("aria-pressed", String(autoPaused));
  t.title = autoPaused ? "Automatische Aktualisierung fortsetzen" : "Automatische Aktualisierung pausieren";
}

$("live-toggle").addEventListener("click", () => {
  autoPaused = !autoPaused;
  pref.set("autoPaused", autoPaused ? "1" : "0");
  renderLive();
  if (autoPaused) clearTimeout(autoTimer);
  else scheduleAuto(500);
});
setInterval(renderLive, 5000);

// ================= Theme =================

function renderThemeSeg() {
  const t = getTheme();
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === t)));
}
document.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => {
  setTheme(b.dataset.themeSet);
  renderThemeSeg();
}));
window.addEventListener("storage", (e) => { if (e.key === "theme") renderThemeSeg(); });

// ================= Start =================

document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("load").addEventListener("click", requestLoad);
$("export").addEventListener("click", exportCsv);
$("search").addEventListener("input", (e) => { query = e.target.value; renderList(); });
$("listings-search").addEventListener("input", (e) => { listingsQuery = e.target.value; renderOffers(); });
$("settings-open").addEventListener("click", openSettings);
$("settings-save").addEventListener("click", saveSettingsFromForm);
$("settings-cancel").addEventListener("click", () => $("settings").close());
$("settings-close").addEventListener("click", () => $("settings").close());
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}
setupResetButton($("reset")); // TEST: vor der finalen Version entfernen

watchLoadState($("status"), $("load"), "Jetzt aktualisieren");
renderThemeSeg();
setChartType(chartType);

async function loadFromStorage() {
  const data = await chrome.storage.local.get(["orders", "sales", "listings", "updatedAt", "manualOrders"]);
  manualOrders = Array.isArray(data.manualOrders) ? data.manualOrders : [];
  // Vinted-Käufe + eigene Käufe von anderen Plattformen.
  purchases = prepareOrders([...(Array.isArray(data.orders) ? data.orders : []), ...manualOrders.map(manualToOrder)]);
  sales = prepareSales(data.sales);
  listings = Array.isArray(data.listings) ? data.listings : [];
  lastUpdatedAt = data.updatedAt || null;
}

(async () => {
  settings = await getSettings();
  [meta, saleLinks, costs] = await Promise.all([getMeta(), getSaleLinks(), getCosts()]);
  await loadFromStorage();
  syncInfo = (await chrome.storage.session.get("sync")).sync || {};
  rebuild();
  renderLive();
  scheduleAuto(1500);
})();

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && changes.sync) {
    syncInfo = changes.sync.newValue || {};
    renderLive();
    return;
  }
  if (area !== "local") return;
  if (changes.updatedAt) { lastUpdatedAt = changes.updatedAt.newValue || null; renderLive(); }
  if (changes.settings) settings = await getSettings();
  if (changes.meta) meta = await getMeta();
  if (changes.saleLinks) saleLinks = await getSaleLinks();
  if (changes.costs) costs = await getCosts();
  if (changes.orders || changes.sales || changes.listings || changes.meta || changes.saleLinks || changes.settings || changes.costs || changes.manualOrders) {
    await loadFromStorage();
    rebuild();
  }
});
