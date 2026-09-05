// Public read API. Serves the merged live feed, archive, front line, SITREPs and
// machine-readable docs straight from KV. No writes (except the /admin/run relay
// and the stats:summary aggregation).

import { fnv, LEGACY_ARCHIVE_CUTOFF } from "../../../shared/schema";
import { safeEqual } from "../../../shared/auth";

interface Env {
  KV: KVNamespace;
  INGEST_STRIKES?: Fetcher;
  INGEST_GROUND?: Fetcher;
  INGEST_FRONTLINE?: Fetcher;
  INGEST_SITREP?: Fetcher;
  RUN_KEY?: string;
  AE?: AnalyticsEngineDataset;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

// Roll up the /hit datapoints (last 30 days) into stats:summary. Runs on cron.
// Groups by (day, visitor-hash) and folds in JS so it only needs sum()/GROUP BY
// — the aggregate-function subset that the Analytics Engine SQL API guarantees.
async function aggregateStats(env: Env): Promise<void> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return;
  const sql =
    "SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, blob1 AS v, " +
    "sum(_sample_interval) AS hits FROM uwl_hits " +
    "WHERE timestamp > NOW() - INTERVAL '30' DAY " +
    "GROUP BY day, blob1 ORDER BY day ASC LIMIT 20000";
  const now = new Date().toISOString();
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: "POST", headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql },
    );
    if (!r.ok) {
      const t = await r.text();
      await env.KV.put("stats:summary", JSON.stringify({ updated: now, error: `query ${r.status}: ${t.slice(0, 140)}` }));
      return;
    }
    const d = (await r.json()) as { data?: Array<{ day: string; v: string; hits: number }> };
    const byDay = new Map<string, { views: number; visitors: number }>();
    for (const row of d.data || []) {
      const e = byDay.get(row.day) || { views: 0, visitors: 0 };
      e.views += Math.round(Number(row.hits) || 0);
      e.visitors += 1;
      byDay.set(row.day, e);
    }
    const days = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, e]) => ({ day, views: e.views, visitors: e.visitors }));
    await env.KV.put(
      "stats:summary",
      JSON.stringify({
        updated: now,
        days,
        views_30d: days.reduce((a, x) => a + x.views, 0),
        visitors_30d: days.reduce((a, x) => a + x.visitors, 0),
        since: days.length ? days[0].day : null,
      }),
    );
  } catch (e) {
    await env.KV.put("stats:summary", JSON.stringify({ updated: now, error: String(e).slice(0, 140) }));
  }
}

interface WarEventLite {
  id?: string;
  event_type: string;
  confidence_tier: string;
  event_utc: string;
  headline?: string;
  summary?: string;
  location_name?: string;
  admin_region?: string;
  actor_from?: string;
  actor_to?: string;
  source_url?: string;
  source_outlet?: string;
  [k: string]: unknown;
}

// Deliberately open: this is a public read API meant to be consumed from
// anywhere. Nothing behind it is authenticated by cookie, so `*` grants no
// ambient authority. SEC_HEADERS ride along on every response.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const LLMS_TXT = `# ukraine-war-live

Automated, serverless OSINT aggregator for the Russia-Ukraine war.
Every event is machine-extracted from public news headlines and is UNVERIFIED.
Casualty figures are numbers announced by one side (Ukraine or Russia), passed
through without checking; they are not confirmed death or injury tolls and are
never summed into a total.

## Endpoints
- /feed.json                       merged live events (strikes + ground), newest first
- /api/events?type=&tier=&since=    same feed, filtered
- /api/search?q=&from=&to=&limit=   substring search over the archive
- /archive/index.json              {date: count} across the whole archive
- /archive/YYYY-MM-DD              that day's events as NDJSON
- /frontline.json                  current occupied-territory polygons (GeoJSON)
- /frontline/history               list of stored past snapshots
- /frontline/history/YYYY-MM-DD    one past snapshot (GeoJSON)
- /sitrep                          index + latest daily situation report
- /sitrep/YYYY-MM-DD               one daily situation report
- /rss.xml                         last 50 events as RSS 2.0
- /status                          last run per pipeline + recent run log
- /llms.txt                        this file

## Event types
missile_strike, drone_strike, air_defense, deep_strike_ru, naval, energy_infra,
ground_engagement, territorial_change, casualty_report, diplomatic

## Confidence tiers
high, official_ua, official_ru, wire, osint, state_media
`;

function xmlEscape(s: string): string {
  return String(s ?? "").replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string),
  );
}

async function readArr(kv: KVNamespace, key: string): Promise<WarEventLite[]> {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as WarEventLite[]) : [];
  } catch {
    return [];
  }
}

function ndjsonToEvents(blob: string | null): WarEventLite[] {
  if (!blob) return [];
  const out: WarEventLite[] = [];
  for (const line of blob.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as WarEventLite);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Each day costs 3 KV reads in /api/search, so the span is hard-capped: an
// unbounded range would let a handful of requests drain the daily read budget.
const SEARCH_MAX_DAYS = 31;

function daysBetween(from: string, to: string): string[] {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
  const out: string[] = [];
  // keep the most recent SEARCH_MAX_DAYS of the requested span
  const start = Math.max(a, b - (SEARCH_MAX_DAYS - 1) * 86400_000);
  for (let t = start; t <= b && out.length < SEARCH_MAX_DAYS; t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ---- privacy-preserving hit beacon (POST, no cookies, fire-and-forget) --
    if (req.method === "POST" && url.pathname === "/hit") {
      try {
        // Only count beacons that actually came from the site. Not a security
        // boundary (Origin is forgeable) — it just keeps stray/bot POSTs out.
        const origin = req.headers.get("origin") || req.headers.get("referer") || "";
        const fromSite = /^https:\/\/(ukraine\.bugg\.club|[a-z0-9-]+\.ukraine-war-live\.pages\.dev|ukraine-war-live\.pages\.dev)\//.test(
          origin.endsWith("/") ? origin : origin + "/",
        );
        if (env.AE && fromSite) {
          const day = new Date().toISOString().slice(0, 10);
          const ip = req.headers.get("cf-connecting-ip") || "";
          const ua = req.headers.get("user-agent") || "";
          const country = (req.cf?.country as string) || "";
          const path = (url.searchParams.get("p") || "/").slice(0, 80);
          // daily-rotating hash: dedupes within a day, cannot link across days,
          // and the raw IP is never stored.
          const vhash = fnv(`${day}|${ip}|${ua}|uwl-stats-v1`);
          env.AE.writeDataPoint({ indexes: [day], blobs: [vhash, path, country], doubles: [1] });
        }
      } catch {
        /* a beacon must never error */
      }
      return new Response(null, { status: 204, headers: CORS });
    }

    // Edge cache for idempotent GETs (skips /admin/*).
    //
    // The cache key is NORMALISED rather than using the raw request: only the
    // params each endpoint actually reads are kept, lower-cased and sorted. Any
    // other query string (`?cb=12345`) would otherwise mint a fresh cache entry
    // and force a full KV re-read — /api/search costs ~93 reads, so a few
    // thousand cache-busted requests could drain the daily read budget.
    const READ_PARAMS: Record<string, string[]> = {
      "/feed.json": ["type", "tier", "since"],
      "/api/events": ["type", "tier", "since"],
      "/api/search": ["q", "from", "to", "limit"],
    };
    const cacheable = req.method === "GET" && !url.pathname.startsWith("/admin/");
    const cache = caches.default;

    // Conditional GET. `If-None-Match` is `"tag"`, `W/"tag"`, a comma list, or
    // `*`; weak-vs-strong is irrelevant here — a match means "the copy you have
    // is still current", so answer 304 and skip re-sending the body.
    const ifNoneMatch = req.headers.get("if-none-match");
    const etagCurrent = (tag: string | null): boolean =>
      !!tag && !!ifNoneMatch &&
      ifNoneMatch.split(",").some((p) => {
        const q = p.trim().replace(/^W\//, "");
        return q === "*" || q === tag.replace(/^W\//, "");
      });
    const notModified = (tag: string, cacheControl: string): Response =>
      new Response(null, { status: 304, headers: { etag: tag, "cache-control": cacheControl, ...CORS } });

    let cacheKey = req;
    if (cacheable) {
      const keep = READ_PARAMS[url.pathname];
      const norm = new URL(url.origin + url.pathname);
      for (const p of (keep || []).slice().sort()) {
        const v = url.searchParams.get(p);
        if (v !== null) norm.searchParams.set(p, v.trim().toLowerCase().slice(0, 128));
      }
      cacheKey = new Request(norm.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) {
        const tag = hit.headers.get("etag");
        return etagCurrent(tag)
          ? notModified(tag!, hit.headers.get("cache-control") || "public, max-age=300")
          : hit;
      }
    }

    // `public, max-age=N` plus an optional stale-while-revalidate window: a
    // revalidating client (the 10-min feed poll) then serves its cached copy
    // immediately and refreshes in the background — usually a ~150-byte 304.
    const cc = (maxAge: number, swr = 0): string =>
      `public, max-age=${maxAge}` + (swr ? `, stale-while-revalidate=${swr}` : "");

    const finish = (resp: Response, maxAge: number): Response => {
      if (!cacheable || resp.status !== 200) return resp;
      if (maxAge > 0) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      const tag = resp.headers.get("etag");
      if (etagCurrent(tag)) return notModified(tag!, resp.headers.get("cache-control")!);
      return resp;
    };
    // `etagSeed` lets a handler hash something narrower than the body: the feed
    // seeds from {meta, events} so its per-request `updated` timestamp does not
    // move the tag when nothing real has changed.
    const json = (
      data: unknown,
      maxAge = 300,
      opts: { etagSeed?: string; swr?: number } = {},
    ) => {
      const s = JSON.stringify(data);
      return finish(
        new Response(s, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": cc(maxAge, opts.swr),
            etag: `"${fnv(opts.etagSeed ?? s)}"`,
            ...CORS,
          },
        }),
        maxAge,
      );
    };
    const body = (
      text: string,
      ct: string,
      maxAge: number,
      extra: Record<string, string> = {},
      opts: { etagSeed?: string; swr?: number } = {},
    ) =>
      finish(
        new Response(text, {
          headers: {
            "content-type": ct,
            "cache-control": cc(maxAge, opts.swr),
            etag: `"${fnv(opts.etagSeed ?? text)}"`,
            ...CORS,
            ...extra,
          },
        }),
        maxAge,
      );

    // ---- live feed -------------------------------------------------------------
    if (url.pathname === "/feed.json" || url.pathname === "/api/events") {
      const [strikes, ground, sStat, gStat, fMeta, sitIdx] = await Promise.all([
        readArr(env.KV, "live:strikes"),
        readArr(env.KV, "live:ground"),
        env.KV.get("status:strikes", "json") as Promise<{ run_id?: string } | null>,
        env.KV.get("status:ground", "json") as Promise<{ run_id?: string } | null>,
        env.KV.get("frontline:meta", "json") as Promise<{ updated?: string } | null>,
        env.KV.get("sitrep:index", "json") as Promise<string[] | null>,
      ]);
      let events = [...strikes, ...ground];

      const type = url.searchParams.get("type");
      const tier = url.searchParams.get("tier");
      const since = url.searchParams.get("since");
      if (type) {
        const set = new Set(type.split(","));
        events = events.filter((e) => set.has(e.event_type));
      }
      if (tier) {
        const set = new Set(tier.split(","));
        events = events.filter((e) => set.has(e.confidence_tier));
      }
      if (since) {
        const t = Date.parse(since);
        if (Number.isFinite(t)) events = events.filter((e) => Date.parse(e.event_utc) >= t);
      }
      events.sort((a, b) => Date.parse(b.event_utc) - Date.parse(a.event_utc));
      const meta = {
        strikes_run: sStat?.run_id ?? null,
        ground_run: gStat?.run_id ?? null,
        frontline_updated: fMeta?.updated ?? null,
        latest_sitrep: Array.isArray(sitIdx) && sitIdx.length ? sitIdx[0] : null,
      };
      return json(
        { updated: new Date().toISOString(), meta, count: events.length, events },
        300,
        // Seed the ETag from the payload minus `updated`, so two rebuilds with
        // the same events and ingest metadata validate as unchanged (304). No
        // stale-while-revalidate here: the poll should still show a fresh body
        // the moment one exists, it just no longer re-downloads an unchanged one.
        { etagSeed: JSON.stringify({ meta, events }) },
      );
    }

    // ---- archive search -----------------------------------------------------
    if (url.pathname === "/api/search") {
      // Cap the term: no legitimate search is long, and an unbounded `q` is free
      // work for an attacker on top of the ~93 KV reads each miss costs.
      const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 128);
      if (q.length < 2) return json({ error: "q must be between 2 and 128 characters", results: [] }, 60);
      const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
      const from =
        url.searchParams.get("from") ||
        new Date(Date.parse(to) - 13 * 86400_000).toISOString().slice(0, 10);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 300));
      const days = daysBetween(from, to);
      const blobs = await Promise.all(
        days.flatMap((d) => [
          env.KV.get(`archive:strikes:${d}`),
          env.KV.get(`archive:ground:${d}`),
          // legacy flat key: only ever written on/before the cutoff, so skip
          // the guaranteed-empty read for every later date (~1/3 of this
          // endpoint's KV reads on a full-span search).
          d <= LEGACY_ARCHIVE_CUTOFF ? env.KV.get(`archive:${d}`) : Promise.resolve(null),
        ]),
      );
      let results: WarEventLite[] = [];
      for (const b of blobs) {
        for (const e of ndjsonToEvents(b)) {
          const hay = `${e.headline} ${e.summary} ${e.location_name} ${e.admin_region} ${e.actor_from} ${e.actor_to} ${e.source_outlet}`.toLowerCase();
          if (hay.includes(q)) results.push(e);
        }
      }
      const seen = new Set<string>();
      results = results
        .filter((e) => {
          const k = e.id || `${e.source_url}|${e.event_utc}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => Date.parse(b.event_utc) - Date.parse(a.event_utc))
        .slice(0, limit);
      // report the span actually searched, not the one requested — daysBetween
      // clamps to SEARCH_MAX_DAYS, and silently returning a narrower result under
      // the requested dates would be misleading.
      return json(
        {
          q,
          from: days.length ? days[0] : from,
          to: days.length ? days[days.length - 1] : to,
          requested_from: from,
          requested_to: to,
          max_days: SEARCH_MAX_DAYS,
          count: results.length,
          results,
        },
        300,
      );
    }

    // ---- archive ----------------------------------------------------------
    if (url.pathname === "/archive/index.json") {
      const [sIdx, gIdx, legacy] = await Promise.all([
        env.KV.get("archive:index:strikes", "json") as Promise<Record<string, number> | null>,
        env.KV.get("archive:index:ground", "json") as Promise<Record<string, number> | null>,
        env.KV.get("archive:index", "json") as Promise<Record<string, number> | null>,
      ]);
      const merged: Record<string, number> = {};
      for (const src of [legacy, sIdx, gIdx]) {
        if (!src) continue;
        for (const [d, n] of Object.entries(src)) merged[d] = (merged[d] || 0) + (n as number);
      }
      return json(merged, 300);
    }

    const archiveMatch = url.pathname.match(/^\/archive\/(\d{4}-\d{2}-\d{2})(?:\.ndjson)?$/);
    if (archiveMatch) {
      const d = archiveMatch[1];
      const [s, g, legacy] = await Promise.all([
        env.KV.get(`archive:strikes:${d}`),
        env.KV.get(`archive:ground:${d}`),
        d <= LEGACY_ARCHIVE_CUTOFF ? env.KV.get(`archive:${d}`) : Promise.resolve(null),
      ]);
      const parts = [legacy, s, g].filter((x): x is string => !!x);
      if (!parts.length) return new Response("no archive for that date\n", { status: 404, headers: CORS });
      return body(parts.join("").replace(/\n?$/, "\n"), "application/x-ndjson; charset=utf-8", 300, {
        "content-disposition": `inline; filename="${d}.ndjson"`,
      });
    }

    // ---- front line -----------------------------------------------------------
    if (url.pathname === "/frontline.json") {
      const raw = await env.KV.get("frontline:geojson");
      if (!raw) return json({ geojson: { type: "FeatureCollection", features: [] }, feature_count: 0 }, 600);
      return body(raw, "application/json; charset=utf-8", 3600, {}, { swr: 86400 });
    }
    if (url.pathname === "/frontline/history") {
      const idx = (await env.KV.get("frontline:snap:index", "json")) as Record<
        string,
        unknown
      > | null;
      return json({ snapshots: idx ? Object.keys(idx).sort().reverse() : [] }, 3600);
    }
    const snapMatch = url.pathname.match(/^\/frontline\/history\/(\d{4}-\d{2}-\d{2})$/);
    if (snapMatch) {
      const raw = await env.KV.get(`frontline:snap:${snapMatch[1]}`);
      if (!raw) return new Response("no snapshot for that date\n", { status: 404, headers: CORS });
      return body(raw, "application/json; charset=utf-8", 86400);
    }

    // ---- SITREP ------------------------------------------------------------
    if (url.pathname === "/sitrep") {
      const idx = ((await env.KV.get("sitrep:index", "json")) as string[] | null) || [];
      const latest = idx.length ? await env.KV.get(`sitrep:${idx[0]}`, "json") : null;
      return json({ dates: idx, latest }, 60); // brief cache; SITREP changes once a day
    }
    const sitMatch = url.pathname.match(/^\/sitrep\/(\d{4}-\d{2}-\d{2})$/);
    if (sitMatch) {
      const s = await env.KV.get(`sitrep:${sitMatch[1]}`, "json");
      if (!s) return new Response("no sitrep for that date\n", { status: 404, headers: CORS });
      // recent reports can still be regenerated; old ones are effectively immutable
      const ageDays = (Date.now() - Date.parse(sitMatch[1])) / 86400_000;
      return json(s, ageDays > 4 ? 86400 : 120);
    }

    // ---- RSS ------------------------------------------------------------------
    if (url.pathname === "/rss.xml") {
      const [strikes, ground] = await Promise.all([
        readArr(env.KV, "live:strikes"),
        readArr(env.KV, "live:ground"),
      ]);
      const events = [...strikes, ...ground]
        .sort((a, b) => Date.parse(b.event_utc) - Date.parse(a.event_utc))
        .slice(0, 50);
      const items = events
        .map((e) => {
          const link = e.source_url || "https://ukraine.bugg.club/";
          const place = [e.location_name, e.admin_region].filter(Boolean).join(", ");
          const desc = `[${e.event_type}] ${place ? place + " — " : ""}${e.summary || e.headline || ""} (${e.source_outlet || "source"}, tier: ${e.confidence_tier})`;
          return `    <item>
      <title>${xmlEscape(e.headline || "event")}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">${xmlEscape(e.id || link)}</guid>
      <pubDate>${new Date(e.event_utc).toUTCString()}</pubDate>
      <description>${xmlEscape(desc)}</description>
    </item>`;
        })
        .join("\n");
      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
    <title>Ukraine War Live</title>
    <link>https://ukraine.bugg.club/</link>
    <description>Automated OSINT feed of the Russia-Ukraine war. Machine-extracted from public news; unverified.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel></rss>`;
      return body(rss, "application/rss+xml; charset=utf-8", 600, {}, {
        // `lastBuildDate` is stamped per request; exclude it so the tag only
        // moves when the items do.
        etagSeed: rss.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, ""),
      });
    }

    // ---- status ------------------------------------------------------------
    if (url.pathname === "/status") {
      const [s, g, f, fStatus, snap, sit, runs] = await Promise.all([
        env.KV.get("status:strikes", "json"),
        env.KV.get("status:ground", "json"),
        env.KV.get("frontline:meta", "json"),
        env.KV.get("status:frontline", "json") as Promise<{ error?: string } | null>,
        env.KV.get("frontline:snap:index", "json") as Promise<Record<string, unknown> | null>,
        env.KV.get("sitrep:index", "json") as Promise<string[] | null>,
        env.KV.get("runs_log", "json"),
      ]);
      return json(
        {
          strikes: s,
          ground: g,
          // frontline: last SUCCESSFUL update ({updated, source_datetime,
          // feature_count}) — never touched by a failed run, so it can't lie
          // about freshness. frontline_status is the last attempt either way,
          // for spotting an outage (mirrors status:strikes / status:ground).
          frontline: f,
          frontline_status: fStatus,
          frontline_snapshots: snap ? Object.keys(snap).sort().reverse() : [],
          sitreps: Array.isArray(sit) ? sit.slice(0, 14) : [],
          recent_runs: Array.isArray(runs) ? runs.slice(0, 12) : [],
        },
        60,
      );
    }

    // ---- admin relay -----------------------------------------------------
    if (url.pathname === "/admin/run") {
      // POST only: this mutates state, and a GET would put RUN_KEY into browser
      // history, Referer headers and any intermediary's access log.
      if (req.method !== "POST") {
        return new Response("method not allowed\n", { status: 405, headers: { ...CORS, allow: "POST" } });
      }
      if (!safeEqual(url.searchParams.get("key"), env.RUN_KEY)) {
        return new Response("forbidden", { status: 403, headers: CORS });
      }
      const which = url.searchParams.get("pipeline") || "both";
      const key = encodeURIComponent(env.RUN_KEY as string);
      const call = async (b: Fetcher | undefined, extra = "") =>
        b ? (await b.fetch(`https://internal/run?key=${key}${extra}`, { method: "POST" })).json() : "no binding";
      const out: Record<string, unknown> = {};
      if (which === "both" || which === "strikes") out.strikes = await call(env.INGEST_STRIKES);
      if (which === "both" || which === "ground") out.ground = await call(env.INGEST_GROUND);
      if (which === "both" || which === "frontline") out.frontline = await call(env.INGEST_FRONTLINE);
      if (which === "sitrep") {
        const date = url.searchParams.get("date");
        out.sitrep = await call(env.INGEST_SITREP, date ? `&date=${date}` : "");
      }
      return json(out, 0);
    }

    if (url.pathname === "/admin/aggregate") {
      if (req.method !== "POST") {
        return new Response("method not allowed\n", { status: 405, headers: { ...CORS, allow: "POST" } });
      }
      if (!safeEqual(url.searchParams.get("key"), env.RUN_KEY)) {
        return new Response("forbidden", { status: 403, headers: CORS });
      }
      await aggregateStats(env);
      return json((await env.KV.get("stats:summary", "json")) || {}, 0);
    }

    if (url.pathname === "/stats") {
      const s = await env.KV.get("stats:summary", "json");
      return json(s || { collecting: true }, 3600);
    }

    if (url.pathname === "/llms.txt") {
      return body(LLMS_TXT, "text/plain; charset=utf-8", 3600);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(aggregateStats(env));
  },
};
