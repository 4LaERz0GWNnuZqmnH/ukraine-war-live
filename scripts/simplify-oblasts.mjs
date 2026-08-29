// Simplify geoBoundaries UKR ADM1 (~3.9 MB) down to a small polygon file the
// browser can load for per-oblast hover counts. Douglas-Peucker, no deps.
//
//   curl -sL <geoBoundaries UKR ADM1 url> -o /tmp/ua_adm1.json
//   node scripts/simplify-oblasts.mjs /tmp/ua_adm1.json web/oblasts.json
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/simplify-oblasts.mjs <in.geojson> <out.json>");
  process.exit(1);
}

const EPS = 0.02; // ~2 km — plenty for hover regions
const DEC = 3;

function perpDist(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1e-12;
  let t = ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx, py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function dp(points, eps) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]];
  return [
    ...dp(points.slice(0, idx + 1), eps).slice(0, -1),
    ...dp(points.slice(idx), eps),
  ];
}

const round = (n) => Math.round(n * 10 ** DEC) / 10 ** DEC;

function simplifyRing(ring) {
  let r = dp(ring, EPS).map(([x, y]) => [round(x), round(y)]);
  // drop consecutive dupes
  r = r.filter((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) {
    r.push(r[0]); // re-close
  }
  return r.length >= 4 ? r : null;
}

function simplifyPolygon(rings) {
  const out = rings.map(simplifyRing).filter(Boolean);
  return out.length ? out : null;
}

// geoBoundaries shapeName -> our short label (matches the site's oblast vocabulary)
const NAME = (s) =>
  s.replace(/ Oblast$/, "")
    .replace("Autonomous Republic of Crimea", "Crimea")
    .replace("Zaporizhia", "Zaporizhzhia")
    .replace("Odessa", "Odesa")
    .replace("Mykolaiv", "Mykolaiv")
    .trim();

const src = JSON.parse(readFileSync(inPath, "utf8"));
const features = [];
for (const f of src.features) {
  const shp = String(f.properties.shapeName || "");
  if (shp === "Kyiv") continue; // Kyiv City sits inside Kyiv Oblast; fold into it
  const name = NAME(shp);
  let geom = null;
  if (f.geometry.type === "Polygon") {
    const p = simplifyPolygon(f.geometry.coordinates);
    if (p) geom = { type: "Polygon", coordinates: p };
  } else if (f.geometry.type === "MultiPolygon") {
    const polys = f.geometry.coordinates.map(simplifyPolygon).filter(Boolean);
    if (polys.length) geom = { type: "MultiPolygon", coordinates: polys };
  }
  if (geom) features.push({ type: "Feature", properties: { name }, geometry: geom });
}

const out = { type: "FeatureCollection", features };
const json = JSON.stringify(out);
writeFileSync(outPath, json);

let pts = 0;
const walk = (a) => (typeof a[0] === "number" ? pts++ : a.forEach(walk));
features.forEach((f) => walk(f.geometry.coordinates));
console.log(`${features.length} oblasts, ${pts} points, ${(json.length / 1024).toFixed(0)} KB -> ${outPath}`);
