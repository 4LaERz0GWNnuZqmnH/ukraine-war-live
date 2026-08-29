// Syntax-check the <script> blocks embedded in the site's HTML pages.
//
//   node scripts/check-inline-js.mjs
//
// `tsc` only covers workers/ and shared/, and the page scripts (Chronology's
// countdown, Status, Today, the About stats block) are inline — so nothing was
// catching a typo in them before deploy. This closes that gap with zero deps.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(ROOT, "web");

const files = [
  resolve(WEB, "index.html"),
  resolve(WEB, "embed.html"),
  ...readdirSync(resolve(WEB, "pages"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => resolve(WEB, "pages", f)),
];

// <script> with no src=; capture the body.
const BLOCK = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let checked = 0;
let failed = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  let m;
  let i = 0;
  while ((m = BLOCK.exec(html)) !== null) {
    const code = m[1];
    i++;
    if (!code.trim()) continue;
    // line number of the block start, for a useful error
    const line = html.slice(0, m.index).split("\n").length;
    checked++;
    try {
      // Parsing as a function body accepts top-level await and return-free code
      // without executing anything.
      new Function(`return (async () => {\n${code}\n})`);
    } catch (err) {
      failed++;
      console.error(`✘ ${file.replace(ROOT + "/", "")}:${line} (inline script #${i})`);
      console.error(`   ${err.message}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} of ${checked} inline script block(s) failed to parse.`);
  process.exit(1);
}
console.log(`inline JS OK — ${checked} block(s) across ${files.length} page(s)`);
