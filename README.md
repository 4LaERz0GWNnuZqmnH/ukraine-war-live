# Ukraine War Live

An automated, serverless OSINT aggregator for the Russia–Ukraine war, modelled on
iranwarlive.com. No humans in the loop: Cloudflare cron → RSS → LLM extraction →
dedup → Google Sheet → cached JSON → static map.

```
RSS feeds ──► ingest-strikes worker ─┐         ┌─► Google Sheet (canonical, CSV)
              ingest-ground worker  ─┼─ KV ────┤
                (Cloudflare cron)    │  cache  └─► uwl-api worker ─► /feed.json
                Workers AI (Llama)   │                                   │
                                     └───────────────► Cloudflare Pages (web/) ◄┘
```

## Cost (target: < $10/month)

| Component | Plan | Monthly |
|---|---|---|
| Workers (3) + Cron Triggers | Free: 100k req/day | $0 |
| Workers KV | Free: 100k reads / 1k writes / day (pipeline uses ~120 writes/day) | $0 |
| Workers AI (Llama 3.3 70B) | Free: 10k neurons/day (~24 runs/day fit) | $0 |
| Cloudflare Pages | Free | $0 |
| Google Sheets API | Free | $0 |
| Domain (optional) | Cloudflare Registrar, .com at cost | ~$0.90 |
| **Total** | | **~$0–1** |

Everything runs on free tiers. Upgrade to **Workers Paid ($5/mo)** only if you add
feeds/runs and start hitting the 1k/day KV write limit.

## One-time setup

### 1. Cloudflare

```bash
npm install
npx wrangler login
npx wrangler kv namespace create WARLIVE_KV
```

Paste the returned `id` into **all three** `workers/*/wrangler.toml` files
(replace `REPLACE_WITH_KV_NAMESPACE_ID`).

Confirm Workers AI is enabled: `npx wrangler ai models` should list models.

### 2. Google Sheet + service account

1. Create a Google Sheet with tabs named exactly:
   `strikes`, `ground`, `casualties`, `diplomacy`.
   Put this header row in each tab (row 1):

   ```
   id  first_seen_utc  event_utc  event_type  headline  summary  location_name  admin_region  country  lat  lon  confidence_tier  actor_from  actor_to  source_outlet  source_url  killed_reported  wounded_reported  reported_by  run_id
   ```

2. Google Cloud Console → new project → **enable the Google Sheets API** →
   **Create credentials → Service account** → create a **JSON key**, download it.
3. Share the Sheet with the service account's `client_email` as **Editor**.
4. (Optional) File → Share → **Publish to web** → CSV per tab for a public export.
5. The Sheet ID is the long string in its URL between `/d/` and `/edit`.

### 3. Worker secrets (set once, persist across deploys)

For **each** ingest worker config:

```bash
# paste the entire service-account JSON file contents when prompted
npx wrangler secret put GOOGLE_SA_JSON --config workers/ingest-strikes/wrangler.toml
npx wrangler secret put SHEET_ID       --config workers/ingest-strikes/wrangler.toml
npx wrangler secret put RUN_KEY        --config workers/ingest-strikes/wrangler.toml   # optional

npx wrangler secret put GOOGLE_SA_JSON --config workers/ingest-ground/wrangler.toml
npx wrangler secret put SHEET_ID       --config workers/ingest-ground/wrangler.toml
npx wrangler secret put RUN_KEY        --config workers/ingest-ground/wrangler.toml   # optional
```

### 4. Deploy

```bash
npm run deploy:all
```

Note the deployed `uwl-api` URL (e.g. `https://uwl-api.<you>.workers.dev`), then:

- edit `web/_redirects` — replace `uwl-api.YOUR-SUBDOMAIN.workers.dev` with it, and
- `npm run deploy:web` again.

Now the frontend can keep `API_BASE = ""` (same-origin via the Pages redirect).

### 5. Seed it (don't wait 2h for the first cron)

```bash
curl -X POST "https://uwl-ingest-strikes.<you>.workers.dev/run?key=YOUR_RUN_KEY"
curl -X POST "https://uwl-ingest-ground.<you>.workers.dev/run?key=YOUR_RUN_KEY"
```

Open the Pages URL — markers should appear within a minute.

### 6. CI/CD (optional)

Push this repo to GitHub. Add repo secrets `CLOUDFLARE_API_TOKEN` (scopes: Workers
Scripts:Edit, Workers KV Storage:Edit, Pages:Edit, Workers AI:Read, Account
Settings:Read) and `CLOUDFLARE_ACCOUNT_ID`. Every push to `main` redeploys all
four targets. Worker secrets set in step 3 are untouched by deploys.

### 7. Custom domain (optional, ~$10/yr)

Register the domain in the Cloudflare dashboard (Registrar, at cost). Add the Pages
custom domain for the apex, and a Worker route `api.<domain>/*` → `uwl-api`
(uncomment the `[[routes]]` block in `workers/api/wrangler.toml`, or set it in the
dashboard). Update `web/_redirects` to point at `https://api.<domain>`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in GOOGLE_SA_JSON, SHEET_ID, RUN_KEY
npm run dev:strikes              # then: curl -XPOST localhost:8787/run
npm run dev:api                  # serves /feed.json from your dev KV
```

## Tuning

- **Feeds** — `shared/sources.json`. Dead feeds are skipped, not fatal. `pipeline`
  is `strikes` | `ground` | `both`; `tier_hint` is a weak prior for the model.
- **Prompts / caps** — `shared/prompts.ts` (caps also enforced in
  `shared/pipeline.ts`: 12 strikes, 6 ground).
- **Model** — default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Set `MODEL` in a
  worker's `[vars]` to trade quality for neurons (e.g. `llama-3.1-8b-instruct-fast`).
- **Schedule** — `crons` in each `wrangler.toml` (currently `0 */2` and `30 */2`).
- **Dedup window / bbox** — `shared/pipeline.ts` (`signatures`) and
  `shared/schema.ts` (`BBOX`).
- **Basemap** — `web/app.js`, `style:` (default: keyless OpenFreeMap Liberty).

## Endpoints

| Path | Description |
|---|---|
| `/feed.json` | merged live events, newest first |
| `/api/events?type=&tier=&since=` | filtered feed (`type`/`tier` comma-separated, `since` ISO) |
| `/status` | last run per pipeline + last 10 run logs |
| `/llms.txt` | machine-readable summary |

## Caveats

Headline-only LLM extraction hallucinates — wrong coordinates, conflated or
misattributed events. Mitigations (temperature 0.1, hard caps, schema validation,
"never invent URLs/coords", state-media tier enforcement) reduce but don't remove
it. Casualty figures are belligerent **claims** and are never summed. Geolocation
is settlement-level at best. Keep the "automated & unverified" banner visible.
