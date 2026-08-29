// Workers AI text models, in preference order. The ingestion pipeline and the
// daily SITREP try them top to bottom and use the first that answers, so a
// retired, overloaded, or quota-exhausted primary degrades to a smaller model
// instead of stopping the run. The model actually used is recorded in the run
// status / SITREP so drift is visible on the Status page.

export const AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3-8b-instruct",
] as const;

export interface AiRunResult {
  response: unknown;
  model: string;
  /** one line per model that threw before the one that answered */
  errors: string[];
}

/**
 * Call `ai.run` against each model in turn. Returns on the first that does not
 * throw; throws only if every model failed (message lists them all).
 */
type AiRun = (model: string, input: unknown) => Promise<{ response?: unknown }>;

export async function runWithFallback(
  ai: Ai,
  models: readonly string[],
  body: Record<string, unknown>,
): Promise<AiRunResult> {
  const errors: string[] = [];
  for (const model of models) {
    try {
      // NB: must be called as a method of `ai` — a detached reference loses the
      // `this` binding and the Workers AI SDK throws on its private fields.
      const out = await (ai.run as unknown as AiRun).call(ai, model, body);
      return { response: out.response, model, errors };
    } catch (e) {
      errors.push(`${model}: ${String(e).slice(0, 160)}`);
    }
  }
  throw new Error(`all AI models failed — ${errors.join(" | ")}`);
}
