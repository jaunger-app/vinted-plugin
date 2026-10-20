// Store-Paket für den Chrome Web Store (2.9.2): node tools/build-store.mjs [zielordner]
// Der Quellcode behält http://localhost:3000 für die Entwicklung; hier wird es entfernt.
// Ins Paket kommt nur, was die Erweiterung lädt – kein shared.js (seit 2.9.0 ungenutzt), keine Tests, nur die Schriften aus popup.css.
// Bricht ab, wenn eine Ersetzung nicht greift, danach noch „localhost“ im Paket steht oder node --check scheitert.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV = "http://localhost:3000";
const OUT_ROOT = process.argv[2] || join(SRC, "dist");

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const name = `refold-${manifest.version}-store`;
const OUT = join(OUT_ROOT, name);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "icons"), { recursive: true });
mkdirSync(join(OUT, "fonts"), { recursive: true });

// --- Manifest ohne Entwicklungsadresse
const strip = (list) => list.filter((u) => !u.startsWith(DEV));
manifest.host_permissions = strip(manifest.host_permissions);
for (const cs of manifest.content_scripts) cs.matches = strip(cs.matches);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// --- Skripte: Adresslisten ohne localhost (genau eine Ersetzung je Datei, sonst Abbruch)
function rewrite(file, pattern, fix) {
  const src = readFileSync(join(SRC, file), "utf8");
  const m = src.match(pattern);
  if (!m) throw new Error(`${file}: ${pattern} nicht gefunden – Build-Skript anpassen`);
  const list = JSON.parse(m[1]).filter((u) => u !== DEV);
  writeFileSync(join(OUT, file), src.replace(m[0], fix(JSON.stringify(list).replace(/","/g, '", "'))));
}
rewrite("account.js", /const WEB_BASES = (\[[^\]]*\]);/, (l) => `const WEB_BASES = ${l};`);
rewrite("background.js", /const WEBAPP_ORIGINS = (\[[^\]]*\]);/, (l) => `const WEBAPP_ORIGINS = ${l};`);
for (const f of ["popup.html", "popup.css", "popup.js", "webapp-bridge.js"]) copyFileSync(join(SRC, f), join(OUT, f));

// --- Icons aus dem Manifest, Schriften aus popup.css
for (const p of new Set(Object.values(manifest.icons))) copyFileSync(join(SRC, p), join(OUT, p));
const fonts = new Set(readFileSync(join(SRC, "popup.css"), "utf8").match(/fonts\/[\w.-]+\.woff2/g));
for (const p of fonts) copyFileSync(join(SRC, p), join(OUT, p));

// --- Prüfen
const files = [];
(function walk(dir, rel = "") {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), rel + e.name + "/");
    else files.push(rel + e.name);
  }
})(OUT);
for (const f of files.filter((f) => /\.(js|json|html|css)$/.test(f))) {
  if (readFileSync(join(OUT, f), "utf8").includes("localhost")) throw new Error(`${f} enthält noch „localhost“`);
}
for (const f of files.filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", join(OUT, f)]);

// --- Zip (Dateien im Wurzelverzeichnis, wie der Store es erwartet; -X ohne macOS-Zusatzattribute)
const zip = join(OUT_ROOT, `${name}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-q", "-X", "-r", zip, "."], { cwd: OUT });
console.log(`${zip}\n${files.length} Dateien: ${files.sort().join(", ")}`);
