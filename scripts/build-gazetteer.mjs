// Rebuild shared/gazetteer.data.json from the GeoNames "cities1000" dump.
//
//   node scripts/build-gazetteer.mjs
//
// Output: a compact { "<normalised name>": [lat, lon] } map of populated places
// inside the map bounding box, merged at runtime UNDER the hand-curated table in
// shared/gazetteer.ts (the hand table always wins). Keys are normalised the same
// way as gazetteer.ts `norm()` so lookups line up.
//
// Adjust COUNTRY_RULES / BBOX for a different theatre (see REBUILD.md).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_URL = "https://download.geonames.org/export/dump/cities1000.zip";
const MEMBER = "cities1000.txt";
const OUT = new URL("../shared/gazetteer.data.json", import.meta.url);

// Must match BBOX in shared/schema.ts.
const BBOX = { latMin: 40, latMax: 63, lonMin: 18, lonMax: 66 };

// country code -> minimum population to include (all must also fall in BBOX)
const COUNTRY_RULES = { UA: 1000, RU: 3000, BY: 10000, MD: 8000 };

const RE_ADMIN = /\b(oblast|raion|region|district|city of)\b/g;
function norm(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(RE_ADMIN, "")
    .replace(/['`’.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extract(zipPath) {
  for (const [cmd, args] of [
    ["unzip", ["-p", zipPath, MEMBER]],
    ["python3", ["-m", "zipfile", "-e", zipPath, "."]],
  ]) {
    try {
      if (cmd === "unzip") return execFileSync(cmd, args, { maxBuffer: 1 << 30 });
      const dir = zipPath.replace(/\/[^/]+$/, "");
      execFileSync(cmd, [args[1], args[2], args[3], dir], { stdio: "ignore" });
      return readFileSync(join(dir, MEMBER));
    } catch {
      /* try next */
    }
  }
  throw new Error("need `unzip` or `python3` on PATH to extract the GeoNames zip");
}

const dir = mkdtempSync(join(tmpdir(), "geonames-"));
const zip = join(dir, "cities1000.zip");
console.error("downloading", SRC_URL);
const buf = Buffer.from(await (await fetch(SRC_URL)).arrayBuffer());
writeFileSync(zip, buf);
console.error("extracting", MEMBER, `(${(buf.length / 1e6).toFixed(1)} MB zip)`);
const text = extract(zip).toString("utf8");
rmSync(dir, { recursive: true, force: true });

const best = new Map(); // key -> { pop, lat, lon }
const kept = Object.fromEntries(Object.keys(COUNTRY_RULES).map((c) => [c, 0]));
for (const line of text.split("\n")) {
  const p = line.split("\t");
  if (p.length < 15) continue;
  const [, name, ascii, , latS, lonS, fclass, , cc] = p;
  if (fclass !== "P" || !(cc in COUNTRY_RULES)) continue;
  const lat = +latS, lon = +lonS, pop = parseInt(p[14] || "0", 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (pop < COUNTRY_RULES[cc]) continue;
  if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) continue;
  for (const raw of [ascii, name]) {
    const k = norm(raw);
    if (k.length < 3 || /^\d+$/.test(k) || !/^[a-z0-9 -]+$/.test(k)) continue;
    const cur = best.get(k);
    if (!cur || pop > cur.pop) best.set(k, { pop, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
  }
  kept[cc]++;
}

const obj = {};
for (const k of [...best.keys()].sort()) obj[k] = [best.get(k).lat, best.get(k).lon];
writeFileSync(OUT, JSON.stringify(obj) + "\n");
console.error("rows kept per country:", kept);
console.error("unique keys:", Object.keys(obj).length, "->", OUT.pathname);
