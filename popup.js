// Kleines Fenster: Reseller-Kurzüberblick, Laden starten, große Übersicht öffnen.

const RECENT_COUNT = 3;
const signed = (v) => (v > 0 ? "+" : v < 0 ? "\u2212" : "") + eur.format(Math.abs(v));

async function render(savedOrders, updatedAt) {
  const manual = await getManualOrders();
  const purchases = prepareOrders([...(Array.isArray(savedOrders) ? savedOrders : []), ...manual.map(manualToOrder)]);
  const has = purchases.length > 0;
  $("updated").textContent = updatedText(updatedAt);
  $("empty").hidden = has;
  $("content").hidden = !has;
  if (!has) return;

  const [meta, settings, links, costs, store] = await Promise.all([getMeta(), getSettings(), getSaleLinks(), getCosts(), chrome.storage.local.get("sales")]);
  const sales = prepareSales(store.sales);
  const { items, events, summary } = resellerModel(purchases, meta, settings, sales, links, costs);
  // Geschäftsjahr: nur das laufende Kalenderjahr, Gewinn nach Betriebskosten.
  const year = new Date().getFullYear();
  const total = aggregate(events, "year", year).total;

  const profitEl = $("profit");
  profitEl.textContent = signed(total.profit);
  profitEl.classList.toggle("neg", total.profit < 0);
  $("profit-label").textContent = `Gewinn ${year} (nach Betriebskosten)`;
  $("stockValue").textContent = eur.format(summary.stockValue);
  $("revenue").textContent = eur.format(total.revenue);
  $("revenue-label").textContent = `Umsatz ${year}`;

  // Private Käufe sind nur zur Ansicht und erscheinen im Popup nicht.
  const business = items.filter((i) => !i.private);
  const groups = statusGroups(business);
  renderBar($("bar"), groups);
  $("legend").replaceChildren(...groups.map((g) =>
    el("li", {}, [dot(g.status.color), `${g.status.label} ${g.count}`])));

  $("list").replaceChildren(...business.slice(0, RECENT_COUNT).map((i) => {
    const st = STATUS_BY_KEY[i.rstatus];
    const right = i.netProfit != null
      ? el("span", { className: `price ${i.netProfit < 0 ? "neg" : "pos"}`, textContent: signed(i.netProfit) })
      : el("span", { className: "price", textContent: eur.format(i.amount) });
    return el("li", { className: `item${i.rstatus === "refund" ? " is-refund" : ""}` }, [
      thumb(i),
      el("div", {}, [
        el("div", { className: "title", textContent: i.title, title: i.title }),
        el("span", { className: "chip" }, [dot(st.color), `${shortDate.format(new Date(i.date))} \u00b7 ${st.label}`]),
      ]),
      right,
    ]);
  }));
}

async function openDashboard() {
  const url = chrome.runtime.getURL("dashboard.html");
  try {
    const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
    if (ctx) {
      await chrome.tabs.update(ctx.tabId, { active: true });
      await chrome.windows.update(ctx.windowId, { focused: true });
      window.close();
      return;
    }
  } catch {
    /* ältere Chrome-Version */
  }
  await chrome.tabs.create({ url });
  window.close();
}

// ---------- Refresh-Token ----------
let tokenValue = null;
let tokenTimer = null;

async function loadToken() {
  const chip = $("token-chip");
  const text = $("token-text");
  try {
    const cookies = await chrome.cookies.getAll({ name: "refresh_token_web", domain: "vinted.de" });
    tokenValue = cookies.map((c) => c.value).find(Boolean) || null;
  } catch {
    tokenValue = null;
  }
  if (tokenValue) {
    text.textContent = tokenValue.slice(0, 28);
    chip.disabled = false;
    chip.classList.remove("is-empty");
  } else {
    text.textContent = "nicht angemeldet";
    chip.disabled = true;
    chip.classList.add("is-empty");
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = el("textarea", { value, style: "position:fixed;opacity:0" });
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
}

async function copyToken() {
  if (!tokenValue) return;
  await copyText(tokenValue);
  const caption = $("token-caption");
  const text = $("token-text");
  caption.textContent = "Kopiert \u2713";
  caption.classList.add("ok");
  text.style.visibility = "hidden";
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(() => {
    caption.textContent = "Refresh-Token";
    caption.classList.remove("ok");
    text.style.visibility = "";
  }, 1500);
}

// ---------- Start ----------
$("load").addEventListener("click", requestLoad);
$("open").addEventListener("click", openDashboard);
$("token-chip").addEventListener("click", copyToken);
setupResetButton($("reset")); // TEST: vor der finalen Version entfernen

chrome.storage.session.get("loadState").then(({ loadState }) => {
  if (!loadState?.running) chrome.action.setBadgeText({ text: "" });
});

watchLoadState($("status"), $("load"), "Jetzt aktualisieren");
watchOrders(render);
loadToken();
