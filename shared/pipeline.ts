// The ingestion pipeline, shared by the strikes and ground workers.
// Stages: RSS -> AI extract -> validate/cap -> dedup -> KV archive + KV live cache.

import sources from "./sources.json";
import { parseFeed } from "./rss";
import { PROMPT_STRIKES, PROMPT_GROUND } from "./prompts";
import { parseEvents, fnv, WarEvent } from "./schema";
import { gridCell } from "./geo";
import { geocode } from "./gazetteer";

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
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

function signatures(ev: WarEvent): string[] {
  const t = Date.parse(ev.event_utc) || Date.now();
  const windowH =
    ev.event_type === "territorial_change" || ev.event_type === "diplomatic" ? 4 : 1;
  const bucket = Math.floor(t / (windowH * 3600 * 1000));
  return [
    `u:${fnv(ev.source_url)}`,
    `g:${ev.event_type}:${gridCell(ev.lat, ev.lon)}:${bucket}`,
  ];
}

async function readMap(kv: KVNamespace, key: string): Promise<Record<string, number>> {
  const raw = await kv.get(key);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function prune(map: Record<string, number>, nowS: number): void {
  for (const k of Object.keys(map)) {
    if (nowS - map[k] > DEDUP_TTL_S) delete map[k];
  }
}

// Durable archive: append kept events as NDJSON to a per-UTC-day KV key, and keep
// a small date->count index. Runs are >=30 min apart (cron) or sequential
// (admin/run), so read-modify-write is safe here.
async function archiveEvents(kv: KVNamespace, events: WarEvent[]): Promise<void> {
  if (!events.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `archive:${day}`;
  const prev = (await kv.get(key)) || "";
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await kv.put(key, prev + lines);

  const idxRaw = await kv.get("archive:index");
  let idx: Record<string, number> = {};
  if (idxRaw) {
    try {
      idx = JSON.parse(idxRaw) as Record<string, number>;
    } catch {
      idx = {};
    }
  }
  idx[day] = (idx[day] || 0) + events.length;
  await kv.put("archive:index", JSON.stringify(idx));
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
    summary: it.summary,
    source_outlet: it.outlet,
    source_url: it.link,
    published: new Date(it.published).toISOString(),
    tier_hint: it.tier_hint,
  }));

  let rawEvents: unknown[] = [];
  try {
    const out = (await env.AI.run(env.MODEL || DEFAULT_MODEL, {
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    })) as { response?: unknown };
    rawEvents = coerceEvents(out.response);
  } catch (e) {
    base.ai_error = String(e).slice(0, 200);
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
      }
    }
  }

  // 5. Cross-run dedup.
  const dedup = await readMap(env.KV, "dedup_store");
  prune(dedup, nowS);

  const kept: WarEvent[] = [];
  for (const ev of events) {
    const sigs = signatures(ev);
    if (sigs.some((s) => dedup[s])) continue;
    for (const s of sigs) dedup[s] = nowS;
    kept.push(ev);
  }
  base.kept = kept.length;

  // 6. Append to the durable archive: one NDJSON blob per UTC day in KV.
  // Swap this for R2 or Google Sheets later without touching anything else.
  if (kept.length) {
    try {
      await archiveEvents(env.KV, kept);
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
