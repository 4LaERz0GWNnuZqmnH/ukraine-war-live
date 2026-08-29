# REBUILD — instructions for an AI agent

You have been given this repository and asked to stand up a similar site on
someone else's infrastructure. This file is the spec. Read it fully before
touching anything, then follow it top to bottom.

The repo *is* the reproducible artifact. The prose in
[`web/pages/build.html`](web/pages/build.html) and
[`web/pages/methodology.html`](web/pages/methodology.html) explains *why* things
are the way they are; the code and data files below are *what you must
reproduce*. Do not paraphrase the prompt, schema, feed, or gazetteer files from
memory — copy them and then edit.

---

## 0. First, ask the operator these questions

Do not start until you have answers. The default in parentheses reproduces the
Ukraine site unchanged.

1. **Which conflict / country is this for?** (Ukraine – Russia war)
   - This drives every choice below. If the answer is "the same", skip to §1.
2. **Site identity** — name, the domain you'll deploy on, accent colour.
   (`Ukraine War Live`, `ukraine.bugg.club`)
3. **News feeds** — 8–15 RSS or Atom URLs covering the conflict in a language
   the extraction model handles well (English is safest). You need the actual
   URLs. (the 13 in `shared/sources.json`)
4. **Map bounding box** — `latMin / latMax / lonMin / lonMax` that encloses the
   theatre plus any territory that gets struck. Coordinates outside it are
   nulled. (`40 / 63 / 18 / 66` — Ukraine + western Russia)
5. **Control-map / front-line layer** — one of:
   - keep [DeepStateMap](https://deepstatemap.live) (Ukraine only);
   - a different manually-drawn control map with a JSON/GeoJSON endpoint
     (e.g. georeferenced ISW data);
   - a locally-committed GeoJSON polygon the operator maintains by hand;
   - none — drop the layer.
   (DeepStateMap)
6. **Admin-1 polygons** for the per-region hover counts — the
   [geoBoundaries](https://www.geoboundaries.org) ISO-3 code for the country, or
   "disable the oblast layer". (`UKR`)
7. **Deploy target** — your own Cloudflare account (required) and whether CI runs
   from a GitHub fork.

Write the answers into a short `PROJECT.md` in the new repo so the choices are
recorded.

---

## 1. Prerequisites

- **Node 22+** (wrangler 4 refuses older).
- A **Cloudflare account** (Free plan is enough) and an **API token** with:
  `Account > Workers Scripts:Edit`, `Account > Workers KV Storage:Edit`,
  `Account > Workers AI:Read` + `Edit`, `Account > Cloudflare Pages:Edit`,
  `Account > Account Settings:Read`, and — if you point a domain on Cloudflare at
  it — `Zone > DNS:Edit` for that zone. Optional but useful:
  `Zone > Zone Settings:Edit` + `Zone > Cache Purge`.
  - **Do not add a Client IP filter to the token if CI will use it** — GitHub
    runners have changing egress IPs and the deploy will fail with auth error
    10000.
- A **workers.dev subdomain** registered once on the account (Cloudflare requires
  one to exist before cron triggers attach). Any unused name.
- A **domain** if you want a custom hostname. It does not have to be on
  Cloudflare, but DNS is simplest if it is.
- If using CI: a **GitHub fork** with repo secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`.

---

## 2. What is country-specific — edit these

| File | Change |
| --- | --- |
| `shared/sources.json` | Replace the `feeds` array with the operator's feed URLs. Keep the `{name, url, pipeline}` shape. `pipeline` is `strikes`, `ground`, or `both`. |
| `shared/gazetteer.ts` | Replace `PLACES` (the hand-curated table — oblast centres, front-line towns, aliases/transliterations). It always wins over the generated set. |
| `shared/gazetteer.data.json` | The ~6k-place fallback. Regenerate with `node scripts/build-gazetteer.mjs` after editing `COUNTRY_RULES` / `BBOX` in that script for the new theatre. |
| `shared/schema.ts` | Set `BBOX` to the operator's bounding box. Review the `event_type` enum — rename/extend for the conflict if needed, and keep `prompts.ts` in sync. |
| `shared/prompts.ts` | Update the actor framing (who attacks whom), the place-name examples, and any Ukraine/Russia-specific tier rules. Keep the "never invent URLs/coordinates", temperature, and strict-JSON-schema instructions **verbatim**. |
| `shared/frontline.ts` | Only if the control-map source changes. Swap the fetch URLs and the feature filter. If dropping the layer, also remove the `ingest-frontline` worker and its `[[services]]` binding in `workers/api`. |
| `web/oblasts.json` | Regenerate: download geoBoundaries ADM1 for the new ISO-3, then `node scripts/simplify-oblasts.mjs <input.geojson> web/oblasts.json`. Update the `NAME()` map in that script for the new region names. Delete the file and the `ly_oblasts` control to disable. |
| `web/*.html`, `web/pages/*.html` | Site name, `<title>`, meta descriptions, the About / Methodology / build copy, accent colour in `web/style.css`. Run `node scripts/nav.mjs` after any nav change. |
| `web/_headers` | `connect-src` / `img-src` in the CSP must list your API host, your tile host, and your control-map host — nothing else. |
| `web/_redirects` | Point the `/feed.json`, `/api/*`, etc. 302s at your API hostname. |
| `web/app.js`, doc pages | `API_BASE` constant → your API hostname. |
| `workers/*/wrangler.toml` | `name` for each worker (must be unique on the account), the KV `id` (see §3), `[[services]]` bindings, and any `routes` / custom-domain blocks. |

## 3. What to keep as-is

The pipeline mechanics are conflict-agnostic — keep them unless you have a
specific reason:

- `shared/pipeline.ts` — fetch → parse → age-filter → AI extract → validate →
  geocode → **two-signature dedup + corroboration** (URL hash + adaptive
  grid/headline hash, 1h/4h buckets, 30-day TTL, 40k-key cap; a duplicate from a
  different outlet promotes the original to `high`) → KV archive + live cache.
- `shared/models.ts` — the ordered Workers AI model list. The pipeline and SITREP
  try them in turn; a per-worker `MODEL` var (optional) is tried first. Adjust the
  list if Cloudflare retires a model.
- `shared/rss.ts` — the regex RSS/Atom parser (Workers have no XML DOM).
- The worker scaffolding and `workers/api` routing.
- One KV namespace for everything. Key families:
  `live:<pipeline>`, `archive:<pipeline>:<YYYY-MM-DD>` (NDJSON) +
  `archive:index:<pipeline>`, `dedup:*` / `processed:*`, `frontline:geojson` +
  `frontline:snap:*` + `frontline:snap:index`, `sitrep:<date>` + `sitrep:index`,
  `status:<pipeline>`, `runs_log`.
- Cron cadence: strikes `0 */2`, ground `30 */2`, frontline `15 */6`,
  sitrep `10 4` (all UTC). The two ingest pipelines are offset so they never
  write KV in the same minute — preserve that offset.

## 4. Deploy

```bash
npm ci
npm run typecheck

# one command: creates the KV namespace, writes its id into every
# workers/*/wrangler.toml, deploys the 5 Workers + Pages, sets RUN_KEY on each.
# Needs `wrangler login` or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
npm run bootstrap
```

Or do it by hand:

```bash
npx wrangler kv namespace create KV        # paste id into all 5 wrangler.toml
for w in ingest-strikes ingest-ground ingest-frontline sitrep api; do
  npx wrangler secret put RUN_KEY --config workers/$w/wrangler.toml
done
npm run deploy:all                         # 5 Workers + Pages; CI does this on push to main
```

Then, in the Cloudflare dashboard or via API:

- add the **custom domain** for `web` (Pages) and for the `api` worker;
- add the **DNS record** if the zone is on Cloudflare;
- if returning visitors get stale assets, set the zone's
  **Browser Cache TTL → "Respect Existing Headers"** (or bump the `?v=` asset
  query in `web/*.html` on every deploy, which is the workaround this repo uses).

## 5. Verify

```bash
curl -s https://<api-host>/status | jq            # feeds_ok, last runs
curl -s -XPOST "https://<api-host>/admin/run?pipeline=strikes&key=$RUN_KEY"
curl -s https://<api-host>/feed.json | jq '.events | length'
```

Load the site: map tiles render, markers appear after the first run, the front
line loads (if kept), the Today tab fills in after the first `sitrep` run.

## 6. Licence obligations you inherit

- **MapLibre GL JS** (BSD-3-Clause), **OpenFreeMap / OpenMapTiles / © OpenStreetMap
  contributors**, **geoBoundaries** (open data), **Llama 3.3** (Llama Community
  Licence — "Built with Llama" notice) — keep the attributions in the build /
  about pages.
- **DeepStateMap is CC BY-NC-SA 4.0.** If you keep that layer, your whole project
  must stay non-commercial, attributed, and share-alike — see this repo's
  `LICENSE`. If you swap it out for a differently-licensed control map or your
  own polygons, you may choose your own licence, but still honour the other
  attributions above.
