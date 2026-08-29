import { generateSitrep, Sitrep } from "../../../shared/sitrep";
import { WarEvent } from "../../../shared/schema";

interface Env {
  KV: KVNamespace;
  AI: Ai;
  RUN_KEY?: string;
}

const DAY = 86400_000;

async function readDayEvents(kv: KVNamespace, date: string): Promise<WarEvent[]> {
  const [s, g, legacy] = await Promise.all([
    kv.get(`archive:strikes:${date}`),
    kv.get(`archive:ground:${date}`),
    kv.get(`archive:${date}`), // pre-2026-08-29 flat key
  ]);
  const events: WarEvent[] = [];
  for (const blob of [s, g, legacy]) {
    if (!blob) continue;
    for (const line of blob.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t) as WarEvent);
      } catch {
        /* skip a malformed line */
      }
    }
  }
  events.sort((a, b) => Date.parse(a.event_utc) - Date.parse(b.event_utc));
  return events;
}

async function run(env: Env, date?: string): Promise<Sitrep> {
  // default: yesterday (a complete UTC day)
  const d = date || new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const events = await readDayEvents(env.KV, d);
  const sitrep = await generateSitrep(env.AI, d, events);
  await env.KV.put(`sitrep:${d}`, JSON.stringify(sitrep));

  const idxRaw = await env.KV.get("sitrep:index");
  let idx: string[] = [];
  if (idxRaw) {
    try {
      idx = JSON.parse(idxRaw);
    } catch {
      idx = [];
    }
  }
  if (!idx.includes(d)) idx.push(d);
  idx.sort().reverse();
  await env.KV.put("sitrep:index", JSON.stringify(idx));
  return sitrep;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env).then((r) => console.log("sitrep", JSON.stringify(r))));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      if (env.RUN_KEY && url.searchParams.get("key") !== env.RUN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const date = url.searchParams.get("date") || undefined;
      return Response.json(await run(env, date));
    }
    return new Response("ukraine-war-live sitrep worker. POST /run[?date=YYYY-MM-DD].", {
      headers: { "content-type": "text/plain" },
    });
  },
};
