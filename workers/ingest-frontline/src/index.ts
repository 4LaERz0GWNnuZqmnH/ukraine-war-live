import {
  fetchFrontline,
  fetchFrontlineAt,
  fetchHistoryList,
  HistoryEntry,
} from "../../../shared/frontline";
import { safeEqual } from "../../../shared/auth";

interface Env {
  KV: KVNamespace;
  RUN_KEY?: string;
}

const DAY = 86400_000;
// Snapshots we try to keep on hand, in days-ago. The frontend "compare" control
// offers whichever of these exist.
const TARGET_AGES = [7, 14, 30, 60, 90];
const SNAP_TTL_DAYS = 130;

function ymd(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

async function ensureSnapshot(
  env: Env,
  index: Record<string, { id: number; datetime: string }>,
  list: HistoryEntry[],
  targetDate: string,
): Promise<boolean> {
  // already have something within 3 days of the target?
  const tt = Date.parse(targetDate);
  for (const d of Object.keys(index)) {
    if (Math.abs(Date.parse(d) - tt) <= 3 * DAY) return false;
  }
  let best: HistoryEntry | null = null;
  let bestDiff = Infinity;
  for (const e of list) {
    const diff = Math.abs(Date.parse(e.createdAt) - tt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  if (!best || bestDiff > 5 * DAY) return false;
  const doc = await fetchFrontlineAt(best.id, best.datetime);
  const snapDate = ymd(Date.parse(best.createdAt));
  await env.KV.put(`frontline:snap:${snapDate}`, JSON.stringify(doc));
  index[snapDate] = { id: best.id, datetime: best.datetime };
  return true;
}

async function run(env: Env): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { updated: new Date().toISOString() };
  try {
    // 1. current control map
    const doc = await fetchFrontline();
    await env.KV.put("frontline:geojson", JSON.stringify(doc));
    await env.KV.put(
      "frontline:meta",
      JSON.stringify({
        updated: doc.updated,
        source_datetime: doc.source_datetime,
        feature_count: doc.feature_count,
      }),
    );
    result.current_features = doc.feature_count;

    // 2. snapshot index
    const idxRaw = await env.KV.get("frontline:snap:index");
    let index: Record<string, { id: number; datetime: string }> = {};
    if (idxRaw) {
      try {
        index = JSON.parse(idxRaw);
      } catch {
        index = {};
      }
    }

    // 3. keep a "today" snapshot (weekly cadence is enough — skip if <6 days old)
    const today = ymd(Date.now());
    const haveRecent = Object.keys(index).some(
      (d) => Date.now() - Date.parse(d) < 6 * DAY,
    );
    if (!haveRecent) {
      await env.KV.put(`frontline:snap:${today}`, JSON.stringify(doc));
      index[today] = { id: 0, datetime: doc.source_datetime };
      result.stored_today = true;
    }

    // 4. backfill missing target ages from DeepState history
    let list: HistoryEntry[] | null = null;
    const added: string[] = [];
    for (const age of TARGET_AGES) {
      const targetDate = ymd(Date.now() - age * DAY);
      const already = Object.keys(index).some(
        (d) => Math.abs(Date.parse(d) - Date.parse(targetDate)) <= 3 * DAY,
      );
      if (already) continue;
      if (!list) list = await fetchHistoryList();
      if (await ensureSnapshot(env, index, list, targetDate)) added.push(targetDate);
    }
    result.backfilled = added;

    // 5. prune old snapshots
    for (const d of Object.keys(index)) {
      if (Date.now() - Date.parse(d) > SNAP_TTL_DAYS * DAY) {
        await env.KV.delete(`frontline:snap:${d}`);
        delete index[d];
      }
    }

    await env.KV.put("frontline:snap:index", JSON.stringify(index));
    result.snapshots = Object.keys(index).sort();
  } catch (e) {
    // Leave frontline:geojson / frontline:meta at their last-known-good state —
    // a failed run must not make stale front-line data look freshly updated.
    result.error = String(e).slice(0, 200);
  }
  // Recorded either way (success or failure), like status:strikes/status:ground,
  // so an outage is visible on /status without touching frontline:meta.
  await env.KV.put("status:frontline", JSON.stringify(result));
  return result;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env).then((r) => console.log("ingest-frontline", JSON.stringify(r))));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      if (!safeEqual(url.searchParams.get("key"), env.RUN_KEY)) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await run(env));
    }
    return new Response("ukraine-war-live frontline worker. POST /run to refresh.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
