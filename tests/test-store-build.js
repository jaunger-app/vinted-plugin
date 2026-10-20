// 2.9.2: Store-Paket (tools/build-store.mjs) – baut in einen Temp-Ordner und prüft, was im Store landet.
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refold-store-"));
try {
  execFileSync(process.execPath, [path.join(ROOT, "tools", "build-store.mjs"), tmp], { stdio: "pipe" });
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const dir = path.join(tmp, `refold-${src.version}-store`);
  assert.ok(fs.existsSync(`${dir}.zip`), "Zip fehlt");

  // Manifest: gleiche Version/Beschreibung/Rechte, nur ohne Entwicklungsadresse
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.strictEqual(m.version, src.version);
  assert.strictEqual(m.description, src.description);
  assert.ok(m.description.length <= 132, "Beschreibung zu lang für den Store");
  assert.deepStrictEqual(m.permissions, src.permissions);
  assert.deepStrictEqual(m.host_permissions, ["https://www.vinted.de/*", "https://jucreative.de/*"]);
  assert.deepStrictEqual(m.content_scripts[0].matches, ["https://jucreative.de/*", "https://www.jucreative.de/*"]);

  // Adresslisten in den Skripten
  const list = (file, name) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1]);
  assert.deepStrictEqual(list("account.js", "WEB_BASES"), ["https://jucreative.de"]);
  assert.deepStrictEqual(list("background.js", "WEBAPP_ORIGINS"), ["https://jucreative.de", "https://www.jucreative.de"]);
  // Quellcode bleibt für die Entwicklung unverändert
  assert.ok(fs.readFileSync(path.join(ROOT, "account.js"), "utf8").includes('"http://localhost:3000"'));

  // Dateiliste: nur, was die Erweiterung lädt
  const files = execFileSync("zipinfo", ["-1", `${dir}.zip`], { encoding: "utf8" }).trim().split("\n").sort();
  for (const f of ["manifest.json", "background.js", "account.js", "popup.html", "popup.js", "popup.css", "webapp-bridge.js", "icons/icon128.png", "fonts/Syne-latin.woff2"]) {
    assert.ok(files.includes(f), `${f} fehlt im Zip`);
  }
  for (const f of files) assert.ok(!/^(tests\/|shared\.js|tools\/|dist\/|.*\.md$|LIESMICH)/.test(f) && !f.includes("__MACOSX"), `${f} gehört nicht ins Paket`);
  console.log(`Store-Build-Tests bestanden (${files.filter((f) => !f.endsWith("/")).length} Dateien).`);
} catch (err) {
  console.error(err.stderr ? String(err.stderr) : err);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
