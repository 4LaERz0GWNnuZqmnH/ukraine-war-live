// Daily SITREP: one Workers AI call over a day's archived events -> a short
// neutral digest. Cheap (one ~200-neuron call/day, well inside the free tier).

import { WarEvent } from "./schema";
import { AI_MODELS, runWithFallback } from "./models";

const PROMPT = `
You are a neutral wire editor. Input is a JSON object with two keys:
- "must_cover": the day's events with the highest reported casualties.
- "events": every machine-extracted event from ONE day of the Russia-Ukraine war
  (each: type, tier, place, actor_from, actor_to, headline, summary,
  killed_reported, wounded_reported, reported_by).

Write a situation report. Output ONLY this JSON object, no prose or fences:
{"headline": "<= 90 chars, the single most significant development of the day",
 "bullets": ["5 to 9 short factual points"]}

Rules:
- Summarise ONLY what is in the input. Do not add outside knowledge or invent detail.
- The headline is normally the strike or attack with the highest reported civilian
  death toll, unless a clearly larger strategic development outweighs it.
- EVERY event in "must_cover" must appear — in the headline or a bullet — with its
  casualty figure and the place, attributed to whoever reported it. "must_cover"
  is ranked purely by figure size and may include battlefield claims of enemy
  losses; reflect those in a bullet, not necessarily the headline.
- Then group the rest (air attacks & air defence; front-line ground action &
  territorial change; Ukrainian deep strikes inside Russia; energy infrastructure;
  naval/Black Sea; diplomacy): one bullet per group that has activity.
- Add a separate bullet for any single locality hit repeatedly or with several
  casualties that a group bullet would otherwise bury.
- Name places and any explicit figures. Attribute claims to who made them
  ("Ukraine's Air Force said...", "Russia's MoD claimed..."). Casualty numbers are
  claims, never present them as confirmed.
- Neutral tone. No adjectives of judgement, no speculation about intent or outcome.
- Each bullet <= 220 characters.
`.trim();

export interface Sitrep {
  date: string;
  headline: string;
  bullets: string[];
  event_count: number;
  generated: string;
  model?: string;
}

function slim(e: WarEvent) {
  return {
    type: e.event_type,
    tier: e.confidence_tier,
    place: [e.location_name, e.admin_region].filter(Boolean).join(", "),
    actor_from: e.actor_from,
    actor_to: e.actor_to,
    headline: e.headline,
    summary: e.summary.slice(0, 200),
    killed_reported: e.killed_reported,
    wounded_reported: e.wounded_reported,
    reported_by: e.reported_by,
  };
}

function coerce(resp: unknown): { headline: string; bullets: string[] } {
  let obj: unknown = resp;
  if (typeof resp === "string") {
    const s = resp.indexOf("{");
    const en = resp.lastIndexOf("}");
    if (s !== -1 && en > s) {
      try {
        obj = JSON.parse(resp.slice(s, en + 1));
      } catch {
        obj = null;
      }
    }
  }
  const o = (obj || {}) as { headline?: unknown; bullets?: unknown };
  const headline = typeof o.headline === "string" ? o.headline.slice(0, 140) : "";
  const bullets = Array.isArray(o.bullets)
    ? o.bullets.filter((b) => typeof b === "string").map((b) => (b as string).slice(0, 300)).slice(0, 12)
    : [];
  return { headline, bullets };
}

export async function generateSitrep(
  ai: Ai,
  date: string,
  events: WarEvent[],
): Promise<Sitrep> {
  const generated = new Date().toISOString();
  if (!events.length) {
    return { date, headline: "No events recorded for this day.", bullets: [], event_count: 0, generated };
  }
  // The deadliest events, chosen deterministically so the model can't drop them.
  const sev = (e: WarEvent) => (e.killed_reported ?? 0) * 1000 + (e.wounded_reported ?? 0);
  const mustCover = [...events]
    .filter((e) => sev(e) > 0)
    .sort((a, b) => sev(b) - sev(a))
    .slice(0, 4);
  const res = await runWithFallback(ai, AI_MODELS, {
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content: JSON.stringify({ must_cover: mustCover.map(slim), events: events.map(slim) }),
      },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  });
  const { headline, bullets } = coerce(res.response);
  return {
    date,
    headline: headline || `${events.length} events recorded.`,
    bullets,
    event_count: events.length,
    generated,
    model: res.model,
  };
}
