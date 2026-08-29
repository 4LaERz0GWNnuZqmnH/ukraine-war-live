# Ukraine War Live

An automated, serverless OSINT map of the Russia–Ukraine war, modelled on
[iranwarlive.com](https://iranwarlive.com). No humans in the loop: Cloudflare
cron Workers pull ~13 RSS feeds, extract discrete events with Workers AI, dedupe
and geocode them, and serve them on a static MapLibre map alongside the
DeepStateMap front line and a daily situation report.

**Live:** <https://ukraine.bugg.club> · **How it works:**
[methodology](https://ukraine.bugg.club/pages/methodology.html) ·
[build write-up](https://ukraine.bugg.club/pages/build.html)

Everything runs on Cloudflare free tiers — the only cost is the domain.

## Layout

```
shared/        pipeline, RSS parser, prompts, gazetteer, dedup, frontline, sitrep
workers/
  ingest-strikes/   cron 0  */2  — RSS → AI → dedup → KV        (PIPELINE=strikes)
  ingest-ground/    cron 30 */2  — same code                    (PIPELINE=ground)
  ingest-frontline/ cron 15 */6  — DeepStateMap current + history snapshots
  sitrep/           cron 10 4    — one AI call over yesterday's archive
  api/              read API on api.ukraine.bugg.club (edge-cached)
web/           static site + self-hosted MapLibre (Cloudflare Pages)
scripts/       nav.mjs (regenerate the menu), simplify-oblasts.mjs
.github/workflows/deploy.yml   push to main → typecheck + deploy everything
```

One Cloudflare KV namespace holds all state (live feed, per-day NDJSON archive,
dedup signatures, front-line GeoJSON + snapshots, daily SITREPs, diagnostics).

## Develop / deploy

```bash
npm install                       # needs Node 22+ (wrangler 4)
npm run typecheck
cp .dev.vars.example .dev.vars    # set RUN_KEY for the /run trigger
npm run dev:strikes               # then: curl -XPOST localhost:8787/run

npm run deploy:all                # or push to main and let CI do it
```

CI needs repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts / KV / Pages /
Workers AI edit, **no IP filter**) and `CLOUDFLARE_ACCOUNT_ID`. A one-off
`wrangler kv namespace create` + pasting the id into `workers/*/wrangler.toml`
is the only manual setup; `RUN_KEY` is set once per worker with
`wrangler secret put`.

## Endpoints (`api.ukraine.bugg.club`, also 302'd from the site domain)

`/feed.json` · `/api/events?type=&tier=&since=` · `/api/search?q=&from=&to=` ·
`/archive/index.json` · `/archive/<date>` · `/frontline.json` ·
`/frontline/history[/<date>]` · `/sitrep[/<date>]` · `/rss.xml` · `/status` ·
`/llms.txt` · `POST /admin/run?pipeline=&key=`

## Caveats

Headline-only LLM extraction hallucinates — wrong coordinates, conflated or
mis-attributed events. Temperature 0.1, hard caps, schema validation, the
"never invent URLs/coordinates" instruction and outlet-based tier enforcement
reduce it; they do not remove it. Casualty figures are numbers **announced by one
side** and are never summed. Geolocation is settlement-level at best. Treat every
event as a lead, not a fact.

## Licence

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see
[`LICENSE`](LICENSE). Third-party components (MapLibre GL, DeepStateMap data,
OpenFreeMap/OSM, geoBoundaries) keep their own licences; see the build write-up.
