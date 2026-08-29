// Build web/ -> dist/ with lossless minification, and deploy dist/ instead.
//
//   node scripts/build-web.mjs      (npm run build:web)
//
// Every transform here preserves behaviour exactly:
//   .js   real-parser minify (esbuild, no syntax lowering)
//   .css  real-parser minify (esbuild)
//   .html whitespace + comment strip; inline <script>/<style> minified with
//         real parsers (html-minifier-terser). <pre>/<textarea> left verbatim.
//   .json  JSON.parse -> JSON.stringify (round-trip, cannot lose data)
//   .svg/.xml  collapse whitespace *between* tags only (no mixed content here)
//   vendor/maplibre-gl.js  already minified upstream; only the trailing
//         //# sourceMappingURL line is dropped (the .map is not shipped, so it
//         is a dead reference / console 404). Bytes are otherwise identical.
//
// Asset refs written as `...?v=NNN` get their version rewritten to an 8-char
// content hash of the built file, so a deploy never serves changed bytes under
// a stale cache key. Refs with no `?v=` are left untouched.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web");
const OUT = join(ROOT, "dist");

const HTML_OPTS = {
  collapseWhitespace: true,
  conservativeCollapse: false,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  keepClosingSlash: true,
  html5: true,
  // Everything below stays off: whitespace + comments + inline JS/CSS only,
  // no attribute rewriting.
  removeRedundantAttributes: false,
  removeEmptyAttributes: false,
  collapseBooleanAttributes: false,
  removeOptionalTags: false,
  removeAttributeQuotes: false,
  sortAttributes: false,
  sortClassName: false,
};

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
const tagCollapse = (s) =>
  s.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").replace(/^\s+/, "").trimEnd() + "\n";

// ---- pass 1: every non-HTML file, recording a content hash per asset ---------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = walk(SRC).map((p) => relative(SRC, p));
const htmlFiles = [];
const hashes = {}; // "/style.css" -> "1a2b3c4d"
const sizes = []; // {rel, rawIn, rawOut}

for (const rel of files) {
  const abs = join(SRC, rel);
  const ext = extname(rel).toLowerCase();
  const raw = readFileSync(abs);
  let out = raw;

  if (ext === ".html") {
    htmlFiles.push(rel);
    continue; // handled in pass 2
  } else if (rel === join("vendor", "maplibre-gl.js")) {
    out = Buffer.from(
      raw.toString("utf8").replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, "\n"),
    );
  } else if (ext === ".js") {
    out = Buffer.from((await esbuild.transform(raw, { loader: "js", minify: true, legalComments: "none" })).code);
  } else if (ext === ".css") {
    out = Buffer.from((await esbuild.transform(raw, { loader: "css", minify: true, legalComments: "none" })).code);
  } else if (ext === ".json") {
    out = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
  } else if (ext === ".svg" || ext === ".xml") {
    out = Buffer.from(tagCollapse(raw.toString("utf8")));
  }

  const dst = join(OUT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, out);
  hashes["/" + rel.split(/[\\/]/).join("/")] = hash8(out);
  sizes.push({ rel, rawIn: raw.length, rawOut: out.length });
}

// ---- pass 2: HTML, with ?v= cache keys rewritten to the built hash ----------
const refRe = /((?:href|src)=")(\/[^"?]+\.(?:css|js))\?v=[^"]*(")/g;

for (const rel of htmlFiles) {
  const srcHtml = readFileSync(join(SRC, rel), "utf8").replace(
    refRe,
    (m, a, path, z) => (hashes[path] ? `${a}${path}?v=${hashes[path]}${z}` : m),
  );
  const min = await minifyHtml(srcHtml, HTML_OPTS);
  const dst = join(OUT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, min);
  sizes.push({ rel, rawIn: Buffer.byteLength(srcHtml), rawOut: Buffer.byteLength(min) });
}

// ---- report ---------------------------------------------------------------
const gz = (p) => gzipSync(readFileSync(p), { level: 9 }).length;
let inRaw = 0, outRaw = 0, inGz = 0, outGz = 0;
console.log("\n  file                              raw            gzip");
console.log("  " + "-".repeat(60));
for (const { rel } of sizes.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const a = join(SRC, rel), b = join(OUT, rel);
  const [ar, br, ag, bg] = [statSync(a).size, statSync(b).size, gz(a), gz(b)];
  inRaw += ar; outRaw += br; inGz += ag; outGz += bg;
  const d = ag - bg;
  console.log(
    `  ${rel.padEnd(30)} ${String(ar).padStart(8)}→${String(br).padStart(7)}  ` +
      `${String(ag).padStart(7)}→${String(bg).padStart(6)}${d > 0 ? `  -${d}` : ""}`,
  );
}
console.log("  " + "-".repeat(60));
const pct = (a, b) => ((1 - b / a) * 100).toFixed(1);
console.log(
  `  ${"TOTAL".padEnd(30)} ${String(inRaw).padStart(8)}→${String(outRaw).padStart(7)}  ` +
    `${String(inGz).padStart(7)}→${String(outGz).padStart(6)}`,
);
console.log(`\n  raw  ${inRaw} → ${outRaw}  (-${pct(inRaw, outRaw)}%)`);
console.log(`  gzip ${inGz} → ${outGz}  (-${pct(inGz, outGz)}%)  [what the CDN actually serves]\n`);
