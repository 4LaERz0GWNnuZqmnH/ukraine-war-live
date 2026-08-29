// Public read API. Serves the merged live feed, status, and machine-readable docs
// straight from KV. No writes, no secrets.

interface Env {
  KV: KVNamespace;
  INGEST_STRIKES?: Fetcher;
  INGEST_GROUND?: Fetcher;
  INGEST_FRONTLINE?: Fetcher;
  RUN_KEY?: string;
}

interface WarEventLite {
  event_type: string;
  confidence_tier: string;
  event_utc: string;
  [k: string]: unknown;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const LLMS_TXT = `# ukraine-war-live

Automated, serverless OSINT aggregator for the Russia-Ukraine war.
Every event is machine-extracted from public news headlines and is UNVERIFIED.
Casualty figures are numbers announced by one side (Ukraine or Russia), passed
through without checking; they are not confirmed death or injury tolls and are
never summed into a total.

## Endpoints
- /feed.json            merged live events (strikes + ground), newest first
- /api/events?type=&tier=&since=   same feed, filtered
- /archive/index.json   {date: count} of the full historical archive
- /archive/YYYY-MM-DD    that day's events as NDJSON (one JSON object per line)
- /frontline.json       occupied-territory polygons (GeoJSON) from DeepStateMap
- /status               last run per pipeline + recent run log
- /llms.txt             this file

## Event types
missile_strike, drone_strike, air_defense, deep_strike_ru, naval, energy_infra,
ground_engagement, territorial_change, casualty_report, diplomatic, pow_exchange

## Confidence tiers
high, official_ua, official_ru, wire, osint, state_media
`;

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const json = (data: unknown, maxAge = 300) =>
      new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${maxAge}`,
          ...CORS,
        },
      });

    if (url.pathname === "/feed.json" || url.pathname === "/api/events") {
      const [strikes, ground] = await Promise.all([
        readArr(env.KV, "live:strikes"),
        readArr(env.KV, "live:ground"),
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
        if (Number.isFinite(t)) {
          events = events.filter((e) => Date.parse(e.event_utc) >= t);
        }
      }
      events.sort((a, b) => Date.parse(b.event_utc) - Date.parse(a.event_utc));
      return json({ updated: new Date().toISOString(), count: events.length, events });
    }

    if (url.pathname === "/archive/index.json") {
      const raw = (await env.KV.get("archive:index")) || "{}";
      return new Response(raw, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...CORS,
        },
      });
    }

    const archiveMatch = url.pathname.match(/^\/archive\/(\d{4}-\d{2}-\d{2})(?:\.ndjson)?$/);
    if (archiveMatch) {
      const raw = await env.KV.get(`archive:${archiveMatch[1]}`);
      if (raw === null) return new Response("no archive for that date\n", { status: 404, headers: CORS });
      return new Response(raw, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "public, max-age=300",
          "content-disposition": `inline; filename="${archiveMatch[1]}.ndjson"`,
          ...CORS,
        },
      });
    }

    if (url.pathname === "/frontline.json") {
      const raw = await env.KV.get("frontline:geojson");
      if (!raw) {
        return json({ geojson: { type: "FeatureCollection", features: [] }, feature_count: 0 }, 600);
      }
      return new Response(raw, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=3600",
          ...CORS,
        },
      });
    }

    if (url.pathname === "/status") {
      const [s, g, f, runs] = await Promise.all([
        env.KV.get("status:strikes", "json"),
        env.KV.get("status:ground", "json"),
        env.KV.get("frontline:meta", "json"),
        env.KV.get("runs_log", "json"),
      ]);
      return json(
        {
          strikes: s,
          ground: g,
          frontline: f,
          recent_runs: Array.isArray(runs) ? runs.slice(0, 10) : [],
        },
        60,
      );
    }

    if (url.pathname === "/admin/run") {
      if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
        return new Response("forbidden", { status: 403, headers: CORS });
      }
      const which = url.searchParams.get("pipeline") || "both";
      const key = encodeURIComponent(env.RUN_KEY);
      const out: Record<string, unknown> = {};
      if ((which === "both" || which === "strikes") && env.INGEST_STRIKES) {
        const r = await env.INGEST_STRIKES.fetch(`https://internal/run?key=${key}`, { method: "POST" });
        out.strikes = await r.json();
      }
      if ((which === "both" || which === "ground") && env.INGEST_GROUND) {
        const r = await env.INGEST_GROUND.fetch(`https://internal/run?key=${key}`, { method: "POST" });
        out.ground = await r.json();
      }
      if ((which === "both" || which === "frontline") && env.INGEST_FRONTLINE) {
        const r = await env.INGEST_FRONTLINE.fetch(`https://internal/run?key=${key}`, { method: "POST" });
        out.frontline = await r.json();
      }
      return json(out, 0);
    }

    if (url.pathname === "/llms.txt") {
      return new Response(LLMS_TXT, {
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
