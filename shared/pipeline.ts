// The ingestion pipeline, shared by the strikes and ground workers.
// Stages: RSS -> AI extract -> validate/cap -> dedup -> KV archive + KV live cache.

import sources from "./sources.json";
import { parseFeed } from "./rss";
import { PROMPT_STRIKES, PROMPT_GROUND } from "./prompts";
import { parseEvents, fnv, WarEvent } from "./schema";
import { gridCell } from "./geo";
import { geocode } from "./gazetteer";
import { AI_MODELS, runWithFallback } from "./models";

export interface Env {
  KV: KVNamespace;
  AI: Ai;
  PIPELINE?: string;
  RUN_KEY?: string;
  MODEL?: string;
}

type Pipeline = "strikes" | "ground";

const MAX_AGE_MS = 96 * 3600 * 1000; // 4-day ingestion window
const DEDUP_TTL_S = 30 * 24 * 3600;
const MAX_ITEMS = 90;

interface FeedDef {
  name: string;
  url: string;
  pipeline: string;
  tier_hint?: string;
}

interface RunResult {
  pipeline: Pipeline;
  run_id: string;
  feeds_ok: number;
  feeds_failed: string[];
  items: number;
  fresh: number;
  extracted: number;
  kept: number;
  promoted: number; // events promoted to "high" this run by fresh corroboration
  model_used?: string;
  model_errors?: string[]; // models that failed before the one that answered
  archive_error?: string;
  ai_error?: string;
}

function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  const slice = text.slice(start, end + 1);
  try {
    const v = JSON.parse(slice);
    return Array.isArray(v) ? v : [];
  } catch {
    // Common failure: a trailing unterminated object. Retry up to the last "}".
    const lastObj = slice.lastIndexOf("}");
    if (lastObj > 0) {
      try {
        const v = JSON.parse(slice.slice(0, lastObj + 1) + "]");
        return Array.isArray(v) ? v : [];
      } catch {
        /* give up */
      }
    }
    return [];
  }
}

// Workers AI returns `response` already parsed when the model emits valid JSON
// (an array, or an object like {events:[...]}); older/other models return a string.
function coerceEvents(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  if (typeof resp === "string") return extractJsonArray(resp);
  if (resp && typeof resp === "object") {
    for (const v of Object.values(resp as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function normHeadline(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

// A dedup-store entry. Legacy runs wrote a bare number (last-seen epoch seconds);
// content signatures now carry the originating event so a later, independent
// report of the same event can corroborate and promote it.
interface DedupEntry {
  t: number; // last-seen, epoch seconds
  id: string; // event id of the first report
  outlet: string; // most recent distinct outlet counted
  tier: string; // current tier of the original event
  n: number; // number of independent outlets seen for this event
}
type DedupVal = number | DedupEntry;
const seenAt = (v: DedupVal): number => (typeof v === "number" ? v : v.t);

// Two signatures per event; the event is a duplicate if either was already seen.
//  - url: catches the same article re-fetched.
//  - content depends on how good the coordinate is:
//    * model-precise point  -> type + 0.1deg cell + time bucket (catches the same
//      real event reported by different outlets within the hour).
//    * gazetteer / no point  -> type + normalised-headline hash + time bucket
//      (a coarse centroid must NOT collapse genuinely distinct events).
function signatures(ev: WarEvent): { url: string; content: string } {
  const t = Date.parse(ev.event_utc) || Date.now();
  const windowH =
    ev.event_type === "territorial_change" || ev.event_type === "diplomatic" ? 4 : 1;
  const bucket = Math.floor(t / (windowH * 3600 * 1000));
  const content =
    ev.lat !== null && ev.geocoded_by === "model"
      ? `g:${ev.event_type}:${gridCell(ev.lat, ev.lon, 0.1)}:${bucket}`
      : `h:${ev.event_type}:${fnv(normHeadline(ev.headline))}:${bucket}`;
  return { url: `u:${fnv(ev.source_url)}`, content };
}

async function readMap(kv: KVNamespace, key: string): Promise<Record<string, DedupVal>> {
  const raw = await kv.get(key);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, DedupVal>;
  } catch {
    return {};
  }
}

const DEDUP_MAX_KEYS = 40000; // hard cap so the blob never approaches KV's 25 MB limit

function prune(map: Record<string, DedupVal>, nowS: number): void {
  for (const k of Object.keys(map)) {
    if (nowS - seenAt(map[k]) > DEDUP_TTL_S) delete map[k];
  }
  const keys = Object.keys(map);
  if (keys.length > DEDUP_MAX_KEYS) {
    keys.sort((a, b) => seenAt(map[a]) - seenAt(map[b])); // oldest first
    for (let i = 0; i < keys.length - DEDUP_MAX_KEYS; i++) delete map[keys[i]];
  }
}

// Durable archive: append kept events as NDJSON to a per-pipeline, per-UTC-day KV
// key (`archive:<pipeline>:<day>`), plus a per-pipeline `{day: count}` index.
// Because each pipeline only ever writes its own keys, the read-modify-write is
// race-free even under KV eventual consistency. The API merges the two on read.
async function archiveEvents(
  kv: KVNamespace,
  events: WarEvent[],
  pipeline: Pipeline,
): Promise<void> {
  if (!events.length) return;
  const day = new Date().toISOString().slice(0, 10);

  const key = `archive:${pipeline}:${day}`;
  const prev = (await kv.get(key)) || "";
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await kv.put(key, prev + lines);

  const idxKey = `archive:index:${pipeline}`;
  const idxRaw = await kv.get(idxKey);
  let idx: Record<string, number> = {};
  if (idxRaw) {
    try {
      idx = JSON.parse(idxRaw) as Record<string, number>;
    } catch {
      idx = {};
    }
  }
  idx[day] = (idx[day] || 0) + events.length;
  await kv.put(idxKey, JSON.stringify(idx));
}

async function logRun(kv: KVNamespace, result: RunResult): Promise<void> {
  const raw = await kv.get("runs_log");
  let arr: RunResult[] = [];
  if (raw) {
    try {
      arr = JSON.parse(raw) as RunResult[];
    } catch {
      arr = [];
    }
  }
  arr.unshift(result);
  await kv.put("runs_log", JSON.stringify(arr.slice(0, 100)));
}

export async function runIngest(env: Env): Promise<RunResult> {
  const pipeline: Pipeline = env.PIPELINE === "ground" ? "ground" : "strikes";
  const runId = new Date().toISOString();
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);

  const feeds = (sources.feeds as FeedDef[]).filter(
    (f) => f.pipeline === pipeline || f.pipeline === "both",
  );

  // 1. Fetch every feed concurrently; a failure is logged, not fatal.
  const settled = await Promise.allSettled(
    feeds.map(async (f) => {
      const r = await fetch(f.url, {
        headers: {
          // Several outlets 403 non-browser agents from datacenter IPs.
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
      const xml = await r.text();
      return parseFeed(xml).map((it) => ({
        ...it,
        outlet: f.name,
        tier_hint: f.tier_hint || "wire",
      }));
    }),
  );

  const feedsFailed: string[] = [];
  let items = settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return s.value;
    feedsFailed.push(`${feeds[i].name}: ${String(s.reason).slice(0, 120)}`);
    return [];
  });

  // 2. Age filter + newest first.
  items = items
    .filter((it) => nowMs - it.published < MAX_AGE_MS)
    .sort((a, b) => b.published - a.published);

  // 3. Drop URLs we have already processed.
  const seen = await readMap(env.KV, "processed_urls");
  prune(seen, nowS);

  const fresh: typeof items = [];
  for (const it of items) {
    if (seen[fnv(it.link)]) continue;
    fresh.push(it);
    if (fresh.length >= MAX_ITEMS) break;
  }

  const base: RunResult = {
    pipeline,
    run_id: runId,
    feeds_ok: feeds.length - feedsFailed.length,
    feeds_failed: feedsFailed,
    items: items.length,
    fresh: fresh.length,
    extracted: 0,
    kept: 0,
    promoted: 0,
  };

  if (!fresh.length) {
    await logRun(env.KV, base);
    await env.KV.put(`status:${pipeline}`, JSON.stringify(base));
    return base;
  }

  // 4. AI extraction.
  const prompt = pipeline === "ground" ? PROMPT_GROUND : PROMPT_STRIKES;
  const payload = fresh.map((it) => ({
    headline: it.title,
    summary: it.summary.slice(0, 200), // headline carries most of the signal
    source_outlet: it.outlet,
    source_url: it.link,
    published: new Date(it.published).toISOString(),
    tier_hint: it.tier_hint,
  }));

  // Try the configured model first (if any), then the shared fallback list.
  const models = env.MODEL
    ? [env.MODEL, ...AI_MODELS.filter((m) => m !== env.MODEL)]
    : [...AI_MODELS];

  let rawEvents: unknown[] = [];
  try {
    const res = await runWithFallback(env.AI, models, {
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    });
    rawEvents = coerceEvents(res.response);
    base.model_used = res.model;
    if (res.errors.length) base.model_errors = res.errors;
  } catch (e) {
    base.ai_error = String(e).slice(0, 300);
    await logRun(env.KV, base);
    await env.KV.put(`status:${pipeline}`, JSON.stringify(base));
    return base;
  }

  const cap = pipeline === "ground" ? 12 : 20;
  const events = parseEvents(rawEvents, runId).slice(0, cap);
  base.extracted = events.length;

  for (const ev of events) {
    // Enforce state-media tier for known state outlets regardless of model choice.
    if (/\b(tass|ria novosti|ria|sputnik)\b/i.test(ev.source_outlet)) {
      ev.confidence_tier = "state_media";
    }
    // Fill coordinates the model left null from the static gazetteer.
    if (ev.lat === null) {
      const hit = geocode(ev.location_name) || geocode(ev.admin_region);
      if (hit) {
        ev.lat = hit[0];
        ev.lon = hit[1];
        ev.geocoded_by = "gazetteer";
      }
    }
  }

  // 5. Cross-run dedup + corroboration.
  //    A duplicate that comes from a DIFFERENT outlet than the first report is
  //    counted as independent corroboration; at 2+ outlets the original event is
  //    promoted to "high" (in the live feed / API — the raw archive line keeps
  //    the tier it was written with).
  const dedup = await readMap(env.KV, "dedup_store");
  prune(dedup, nowS);

  const promote = new Map<string, number>(); // event id -> corroboration count
  const kept: WarEvent[] = [];
  for (const ev of events) {
    const sig = signatures(ev);
    if (dedup[sig.url] != null) continue; // exact article already processed

    const hit = dedup[sig.content];
    if (hit != null) {
      if (typeof hit === "object" && hit.outlet && ev.source_outlet &&
          hit.outlet.toLowerCase() !== ev.source_outlet.toLowerCase()) {
        hit.n = (hit.n || 1) + 1;
        hit.outlet = ev.source_outlet; // a further distinct outlet still counts
        hit.t = nowS;
        if (hit.n >= 2) {
          hit.tier = "high";
          promote.set(hit.id, hit.n); // keep the count climbing on each new outlet
        }
      }
      dedup[sig.url] = nowS;
      continue; // still a duplicate — not re-added
    }

    // genuinely new
    dedup[sig.url] = nowS;
    dedup[sig.content] = {
      t: nowS,
      id: ev.id,
      outlet: ev.source_outlet,
      tier: ev.confidence_tier,
      n: 1,
    };
    kept.push(ev);
  }

  // Same-run corroboration can land on an event we just kept.
  for (const e of kept) {
    const n = promote.get(e.id);
    if (n) {
      e.confidence_tier = "high";
      e.corroborations = n;
    }
  }
  base.kept = kept.length;
  base.promoted = promote.size;

  // 6. Append to the durable archive (KV, one NDJSON key per pipeline per day).
  if (kept.length) {
    try {
      await archiveEvents(env.KV, kept, pipeline);
    } catch (e) {
      base.archive_error = String(e).slice(0, 200);
    }
  }

  // 7. Update the live feed cache for this pipeline.
  const liveKey = `live:${pipeline}`;
  const prevRaw = await env.KV.get(liveKey);
  let prev: WarEvent[] = [];
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw) as WarEvent[];
    } catch {
      prev = [];
    }
  }
  // Apply cross-run promotions to events already in the live feed.
  for (const e of prev) {
    const n = promote.get(e.id);
    if (n) {
      e.confidence_tier = "high";
      e.corroborations = n;
    }
  }
  const keptIds = new Set(kept.map((e) => e.id));
  const merged = [...kept, ...prev.filter((e) => !keptIds.has(e.id))].slice(0, 200);
  await env.KV.put(liveKey, JSON.stringify(merged));

  // 8. Persist dedup state + status.
  for (const it of fresh) seen[fnv(it.link)] = nowS;
  await env.KV.put("processed_urls", JSON.stringify(seen));
  await env.KV.put("dedup_store", JSON.stringify(dedup));
  await env.KV.put(`status:${pipeline}`, JSON.stringify(base));
  await logRun(env.KV, base);

  return base;
}

/** Shared fetch handler for both ingest workers: `POST /run[?key=RUN_KEY]`. */
export async function handleIngestFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/run") {
    if (env.RUN_KEY && url.searchParams.get("key") !== env.RUN_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    const result = await runIngest(env);
    return Response.json(result);
  }
  return new Response(
    `ukraine-war-live ingest worker (${env.PIPELINE || "strikes"}). POST /run to trigger.`,
    { headers: { "content-type": "text/plain" } },
  );
}
