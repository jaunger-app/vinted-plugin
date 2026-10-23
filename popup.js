// Popup der Erweiterung (2.9.0): kein Dashboard mehr – nur Anmelden (refold-Konto der Website) und, angemeldet,
// das Nötigste: Vinted-Status im Browser, Konten aus der Web-App, „Jetzt aktualisieren“, Dashboard öffnen, Abmelden.
// Konto-/Sitzungslogik: account.js. Die Brücke zur Web-App (webapp-bridge.js + background.js) läuft unabhängig davon.

const $ = (id) => document.getElementById(id);
const views = ["v-loading", "v-login", "v-app"];
function show(id) { for (const v of views) $(v).hidden = v !== id; }

function setMsg(el, text, kind = "") {
  el.textContent = text || "";
  el.hidden = !text;
  el.className = `msg${kind ? ` is-${kind}` : ""}`;
}

const MODE = { extension: "über Erweiterung", own: "eigene Sitzung" };
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "gerade eben";
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `vor ${h} h` : `vor ${Math.round(h / 24)} T`;
}

// ---------- Server-Auswahl und Links ----------
async function setupServer() {
  const sel = $("server");
  // Store-Version kennt nur eine Adresse (tools/build-store.mjs) – dann gibt es nichts zu wählen.
  if (WEB_BASES.length < 2) { sel.closest(".server").hidden = true; return; }
  const current = await getBase();
  sel.replaceChildren(...WEB_BASES.map((b) => {
    const o = document.createElement("option");
    o.value = b; o.textContent = hostOf(b); o.selected = b === current;
    return o;
  }));
  sel.addEventListener("change", async () => {
    await setBase(sel.value);
    await start(); // andere Adresse = andere Sitzung
  });
}
async function updateLinks() {
  const base = await getBase();
  // Nach der Registrierung direkt zur Seite „Erweiterung verbinden“ (verbindet mit einem Klick)
  $("register").href = `${base}/login?mode=register&next=${encodeURIComponent("/erweiterung-verbinden")}`;
  $("open-dashboard").href = `${base}/dashboard`;
}

// ---------- A: Anmelden ----------
$("pw-toggle").addEventListener("click", () => {
  const input = $("password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("pw-toggle").textContent = showing ? "Anzeigen" : "Verbergen";
  $("pw-toggle").setAttribute("aria-pressed", String(!showing));
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true; btn.textContent = "Anmelden …";
  setMsg($("login-msg"), "");
  try {
    const user = await login($("email").value, $("password").value);
    $("password").value = "";
    await showApp(user);
  } catch (err) {
    const text = err instanceof AccountError ? err.message : "Die Anmeldung hat nicht geklappt. Bitte erneut versuchen.";
    const hint = err?.kind === "credentials" ? " Mit Google registriert? Dann nutze oben „Mit Google anmelden“." : "";
    setMsg($("login-msg"), text + hint, "err");
    $("password").focus();
  } finally {
    btn.disabled = false; btn.textContent = "Anmelden";
  }
});

// Google (und jeder andere Website-Login): Die Website meldet an und übergibt der Erweiterung danach eine Sitzung
// (Seite /erweiterung-verbinden, Brücke webapp-bridge.js → background.js webappSession). Kein OAuth-Schlüssel hier.
$("google").addEventListener("click", async () => {
  const base = await getBase();
  await chrome.tabs.create({ url: `${base}/erweiterung-verbinden` });
  window.close();
});
// Bleibt das Popup offen (z. B. angeheftet), wechselt es nach der Übergabe sofort in die angemeldete Ansicht.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.extAuth?.newValue && !$("v-login").hidden) start();
});

$("reset").addEventListener("click", async () => {
  const msg = $("login-msg");
  try {
    await requestPasswordReset($("email").value);
    setMsg(msg, "Wenn es ein Konto mit dieser E-Mail gibt, ist der Link zum Zurücksetzen unterwegs.", "ok");
  } catch (err) {
    setMsg(msg, err instanceof AccountError ? err.message : "Das hat gerade nicht geklappt.", "err");
    if (err?.kind === "input") $("email").focus();
  }
});

// ---------- B: angemeldet ----------
async function showApp(user) {
  show("v-app");
  $("user-email").textContent = user?.email || "unbekannt";
  $("avatar").textContent = (user?.email || "?").slice(0, 1);
  setMsg($("app-msg"), "");
  await Promise.all([renderMonth(), renderVinted(), renderAccounts()]);
}

// 2.9.7 (Web-App 060): Umsatz und Gewinn (nach Betriebskosten) des laufenden Monats über alle Konten – rechnet der Server
// genau wie die Übersicht im Dashboard; hier nur anzeigen.
const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
async function renderMonth() {
  try {
    const { summary } = await authedRequest("/api/extension/summary");
    $("month-label").textContent = summary?.label || "Diesen Monat";
    $("month-revenue").textContent = EUR.format(Number(summary?.revenue) || 0);
    const profit = Number(summary?.profit) || 0;
    $("month-profit").textContent = EUR.format(profit);
    $("month-profit").classList.toggle("is-neg", profit < 0);
    const missing = Number(summary?.profitMissing) || 0;
    $("month-hint").textContent = missing ? `${missing === 1 ? "1 Verkauf" : `${missing} Verkäufe`} ohne zugeordneten Einkauf – Gewinn dafür nicht enthalten.` : "";
  } catch (err) {
    if (err?.kind === "expired") return backToLogin(err.message);
    $("month-revenue").textContent = "–"; $("month-profit").textContent = "–";
    $("month-hint").textContent = "Übersicht gerade nicht verfügbar.";
  }
}

async function renderVinted() {
  let loggedIn = false;
  try {
    const cookies = await chrome.cookies.getAll({ domain: "vinted.de", name: "refresh_token_web" });
    loggedIn = cookies.some((c) => !!c.value); // nur prüfen, ob vorhanden – der Wert wird nirgends angezeigt
  } catch { /* ohne Cookie-Zugriff: unbekannt */ }
  const { lastHandoffAt } = await chrome.storage.session.get("lastHandoffAt");
  $("vinted-dot").className = `dot ${loggedIn ? "is-ok" : "is-warn"}`;
  $("vinted-text").textContent = loggedIn ? "Angemeldet" : "Nicht angemeldet";
  $("vinted-hint").textContent = loggedIn
    ? (lastHandoffAt ? `Zugang zuletzt an die Web-App gegeben: ${ago(lastHandoffAt)}` : "Die Web-App holt sich den Zugang, sobald sie geöffnet ist.")
    : "Melde dich in diesem Browser bei vinted.de an, damit die Web-App deine Daten abgleichen kann.";
}

async function renderAccounts() {
  const list = $("accounts");
  try {
    const { accounts } = await authedRequest("/api/vinted/accounts");
    if (!accounts?.length) {
      list.replaceChildren(li("Noch kein Vinted-Konto verbunden – das geht im Dashboard.", "muted"));
      return;
    }
    list.replaceChildren(...accounts.slice(0, 5).map((a) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name"; name.textContent = a.label || (a.login ? `@${a.login}` : "Vinted-Konto");
      const mode = document.createElement("span");
      mode.className = "mode"; mode.textContent = MODE[a.mode] || "";
      item.append(name, mode);
      return item;
    }), ...(accounts.length > 5 ? [li(`+ ${accounts.length - 5} weitere`, "muted")] : []));
  } catch (err) {
    if (err?.kind === "expired") return backToLogin(err.message);
    list.replaceChildren(li(err instanceof AccountError ? err.message : "Konten konnten nicht geladen werden.", "muted"));
  }
}
function li(text, cls) { const n = document.createElement("li"); n.className = cls; n.textContent = text; return n; }

$("sync").addEventListener("click", async () => {
  const btn = $("sync");
  btn.disabled = true; btn.textContent = "Läuft …";
  try {
    const r = await authedRequest("/api/vinted/sync", { method: "POST", body: { manual: true } });
    setMsg($("app-msg"), r.skipped ? "Abgleich übersprungen (gerade erst gelaufen oder Vinted bremst)." : "Abgleich angestoßen – das Dashboard zeigt den neuen Stand.", r.skipped ? "" : "ok");
  } catch (err) {
    if (err?.kind === "expired") return backToLogin(err.message);
    setMsg($("app-msg"), err instanceof AccountError ? err.message : "Abgleich fehlgeschlagen.", "err");
  } finally {
    btn.disabled = false; btn.textContent = "Jetzt aktualisieren";
  }
});

$("logout").addEventListener("click", async () => {
  await logout();
  backToLogin("Du bist abgemeldet.", "ok");
});

function backToLogin(message, kind = "err") {
  show("v-login");
  setMsg($("login-msg"), message || "", message ? kind : "");
  $("email").focus();
}

// ---------- Start ----------
async function start() {
  show("v-loading");
  await updateLinks();
  try {
    const user = await currentUser(); // serverseitig geprüft
    if (user) return await showApp(user);
    backToLogin("");
  } catch (err) {
    if (err?.kind === "network") {
      // Sitzung bleibt gespeichert – nur der Server ist gerade nicht erreichbar.
      backToLogin(`${err.message} Deine Anmeldung bleibt gespeichert.`);
      return;
    }
    backToLogin(err instanceof AccountError ? err.message : "");
  }
}

$("ver").textContent = `v${chrome.runtime.getManifest().version}`;
setupServer().then(start);
