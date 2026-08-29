import { fetchFrontline } from "../../../shared/frontline";

interface Env {
  KV: KVNamespace;
  RUN_KEY?: string;
}

async function run(env: Env): Promise<Record<string, unknown>> {
  try {
    const doc = await fetchFrontline();
    await env.KV.put("frontline:geojson", JSON.stringify(doc));
    const meta = {
      updated: doc.updated,
      source_datetime: doc.source_datetime,
      feature_count: doc.feature_count,
    };
    await env.KV.put("frontline:meta", JSON.stringify(meta));
    return meta;
  } catch (e) {
    const err = { error: String(e).slice(0, 200), updated: new Date().toISOString() };
    await env.KV.put("frontline:meta", JSON.stringify(err));
    return err;
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env).then((r) => console.log("ingest-frontline", JSON.stringify(r))));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      if (env.RUN_KEY && url.searchParams.get("key") !== env.RUN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await run(env));
    }
    return new Response("ukraine-war-live frontline worker. POST /run to refresh.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
