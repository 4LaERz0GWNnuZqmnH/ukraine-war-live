// One-shot deploy of the whole stack to YOUR Cloudflare account.
//
//   node scripts/bootstrap.mjs [--yes] [--run-key <str>] [--kv-id <id>]
//
// Does, in order:
//   1. checks Node >= 22 and that `wrangler` runs
//   2. creates a Workers KV namespace (unless --kv-id given)
//   3. writes that id into all workers/<name>/wrangler.toml
//   4. deploys the 5 Workers + the Pages site  (npm run deploy:all)
//   5. sets the RUN_KEY secret on every Worker (generated unless --run-key given)
//   6. prints the manual follow-ups it cannot do for you
//
// Auth: relies on wrangler's own resolution — either `wrangler login`, or
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment. The token
// needs Workers Scripts:Edit, Workers KV Storage:Edit, Workers AI:Edit,
// Cloudflare Pages:Edit, Account Settings:Read (+ Zone DNS:Edit if you point a
// Cloudflare zone at it). Do NOT add a Client IP filter if CI will reuse it.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS = [
  "ingest-strikes",
  "ingest-ground",
  "ingest-frontline",
  "sitrep",
  "api",
].map((n) => ({ name: n, toml: join(ROOT, "workers", n, "wrangler.toml") }));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
if (flag("--help") || flag("-h")) {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  const doc = [];
  for (const l of lines) { if (!l.startsWith("//")) break; doc.push(l.replace(/^\/\/ ?/, "")); }
  console.log(doc.join("\n"));
  process.exit(0);
}

function sh(cmd, cmdArgs, input) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    stdio: input === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    throw new Error(`${cmd} ${cmdArgs.join(" ")} exited ${r.status}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}

// 1. preflight -------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Node ${process.versions.node}: wrangler 4 needs Node >= 22.`);
  process.exit(1);
}
try {
  const v = execFileSync("npx", ["--no-install", "wrangler", "--version"], { cwd: ROOT, encoding: "utf8" });
  console.log("wrangler:", v.trim().split("\n").pop());
} catch {
  console.error("`npx wrangler` did not run. Run `npm install` first.");
  process.exit(1);
}

const currentIds = [...new Set(
  WORKERS.map((w) => (readFileSync(w.toml, "utf8").match(/id\s*=\s*"([0-9a-f]{32})"/) || [])[1]).filter(Boolean),
)];

console.log("\nPlan:");
console.log("  • create a KV namespace" + (opt("--kv-id") ? ` (skipped, using ${opt("--kv-id")})` : ""));
console.log(`  • rewrite KV id in ${WORKERS.length} wrangler.toml files` +
  (currentIds.length ? ` (currently ${currentIds.join(", ")})` : ""));
console.log("  • npm run deploy:all  (5 Workers + Pages)");
console.log("  • set RUN_KEY secret on each Worker" + (opt("--run-key") ? " (provided)" : " (generated)"));

if (!flag("--yes")) {
  const rl = createInterface({ input: stdin, output: stdout });
  const a = (await rl.question("\nProceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (a !== "y" && a !== "yes") { console.log("aborted."); process.exit(0); }
}

// 2. KV namespace --------------------------------------------------------
let kvId = opt("--kv-id");
if (!kvId) {
  console.log("\n→ creating KV namespace…");
  const out = sh("npx", ["wrangler", "kv", "namespace", "create", "KV"]);
  kvId = (out.match(/id\s*=\s*"([0-9a-f]{32})"/) || out.match(/"id":\s*"([0-9a-f]{32})"/) || [])[1];
  if (!kvId) { console.error(out); throw new Error("could not parse the new namespace id"); }
  console.log("  id:", kvId);
}

// 3. rewrite tomls -----------------------------------------------------
for (const w of WORKERS) {
  const src = readFileSync(w.toml, "utf8");
  const next = src.replace(
    /(\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*")[0-9a-f]{32}(")/,
    `$1${kvId}$2`,
  );
  if (next !== src) { writeFileSync(w.toml, next); console.log("  wrote", w.name, "wrangler.toml"); }
}

// 4. deploy -----------------------------------------------------------
console.log("\n→ npm run deploy:all …");
sh("npm", ["run", "deploy:all"]);

// 5. secret ---------------------------------------------------------
const runKey = opt("--run-key") || randomBytes(24).toString("base64url");
console.log("\n→ setting RUN_KEY on each Worker…");
for (const w of WORKERS) {
  sh("npx", ["wrangler", "secret", "put", "RUN_KEY", "--config", w.toml], runKey + "\n");
  console.log("  set on", w.name);
}

// 6. done ---------------------------------------------------------
console.log(`
Done. Still manual (needs the dashboard or your own DNS):
  • add a custom domain to the "api" Worker and to the Pages project
  • add the DNS records for those hostnames
  • register a workers.dev subdomain on the account if cron triggers don't attach
  • Cloudflare zone → Caching → Browser Cache TTL → "Respect Existing Headers"
  • update API_BASE in web/app.js + the doc pages, and the hostnames in
    web/_redirects / web/_headers, to your API domain

RUN_KEY (also needed for POST /admin/run):
  ${runKey}
`);
