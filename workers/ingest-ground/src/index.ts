import { runIngest, handleIngestFetch, Env } from "../../../shared/pipeline";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runIngest(env).then((r) => console.log("ingest-ground", JSON.stringify(r))),
    );
  },
  fetch: handleIngestFetch,
};
