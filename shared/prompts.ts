// Extraction prompts. Kept terse and rule-heavy; temperature is 0.1 at call site.

const COMMON = `
You are an OSINT extraction engine for the Russia-Ukraine war. Input is a JSON array
of recent news items, each: {headline, summary, source_outlet, source_url, published, tier_hint}.

Output ONLY a JSON array of event objects. No prose, no markdown fences, no comments.

Hard rules:
- One object per DISTINCT, CONCRETE event. If an item reports no concrete event
  (analysis, opinion, round-up, anniversary), skip it.
- NEVER invent source_url. Copy the exact source_url of the item the event came from.
- NEVER invent coordinates. Set lat/lon to the settlement's real decimal degrees ONLY
  if you are confident; otherwise use null. Do not guess.
- event_utc: ISO 8601 UTC. If the item gives no explicit event time, use its "published".
- summary: <= 240 chars, factual, no editorialising, name the actors.
- Deduplicate within your own output.

confidence_tier — choose exactly one:
- "high"        : the same event is reported by 2+ independent outlets in THIS input
- "official_ua" : claim attributed to Ukraine's military / government / regional officials
- "official_ru" : claim attributed to Russia's Ministry of Defence / government
- "wire"        : a single mainstream outlet, not attributed to Ukraine or Russia
- "osint"       : geolocated / analyst-sourced (ISW, DeepState, named OSINT)
- "state_media" : sourced to TASS / RIA / Sputnik and not independently confirmed
Use tier_hint as a weak prior only; the rules above win.

actor_from = attacking / claiming party. actor_to = target party or force.
killed_reported / wounded_reported: integers if a figure is explicitly stated, else null.
reported_by: who asserted the casualty / claim (e.g. "Ukraine Air Force", "Russian MoD").

Object shape (all keys required):
{"event_type","headline","summary","location_name","admin_region","country",
 "lat","lon","confidence_tier","actor_from","actor_to","source_outlet",
 "source_url","killed_reported","wounded_reported","reported_by","event_utc"}
`.trim();

export const PROMPT_STRIKES = `
${COMMON}

For THIS pass, emit ONLY these event_type values:
- "missile_strike"  : cruise / ballistic missile impact or launch salvo
- "drone_strike"    : one-way attack drone (Shahed/Geran etc.) impact or mass launch
- "air_defense"     : interception / shoot-down of missiles or drones
- "deep_strike_ru"  : Ukrainian long-range strike INSIDE Russia (refinery, airfield, depot)
- "naval"           : Black Sea Fleet, Crimea naval, port / ship strikes
- "energy_infra"    : deliberate strikes on power grid, substations, gas, heating

Ignore front-line ground combat, territorial change, and diplomacy in this pass.
Emit at most 20 objects — keep the most significant and most recently reported.
`.trim();

export const PROMPT_GROUND = `
${COMMON}

For THIS pass, emit ONLY these event_type values:
- "ground_engagement" : infantry / armour / artillery combat at a named place on the front
- "territorial_change": a settlement captured, lost, or claimed by either side

Explicitly IGNORE airstrikes, missiles, drones, air defence, naval action, and
diplomatic statements in this pass.
Emit at most 12 objects — prefer confirmed territorial changes over routine shelling.
`.trim();
