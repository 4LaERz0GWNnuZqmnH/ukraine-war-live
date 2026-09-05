// Event schema and validation — shared by all workers.

export type ConfidenceTier =
  | "high"
  | "official_ua"
  | "official_ru"
  | "wire"
  | "osint"
  | "state_media";

export type EventType =
  | "missile_strike"
  | "drone_strike"
  | "air_defense"
  | "deep_strike_ru"
  | "naval"
  | "energy_infra"
  | "ground_engagement"
  | "territorial_change"
  | "casualty_report"
  | "diplomatic";

export interface WarEvent {
  id: string;
  first_seen_utc: string;
  event_utc: string;
  event_type: EventType;
  headline: string;
  summary: string;
  location_name: string;
  admin_region: string;
  country: string;
  lat: number | null;
  lon: number | null;
  geocoded_by: "model" | "gazetteer" | null;
  confidence_tier: ConfidenceTier;
  actor_from: string;
  actor_to: string;
  source_outlet: string;
  source_url: string;
  killed_reported: number | null;
  wounded_reported: number | null;
  reported_by: string;
  run_id: string;
  /** independent outlets seen for this event; set once it reaches 2 (tier -> high) */
  corroborations?: number;
}

const TYPES = new Set<string>([
  "missile_strike", "drone_strike", "air_defense", "deep_strike_ru", "naval",
  "energy_infra", "ground_engagement", "territorial_change", "casualty_report",
  "diplomatic",
]);
const TIERS = new Set<string>([
  "high", "official_ua", "official_ru", "wire", "osint", "state_media",
]);

// Rough bounding box: Ukraine + Black Sea + western/central Russia (deep strikes
// reach refineries as far as Tatarstan). Anything outside is treated as no-geo.
const BBOX = { latMin: 40, latMax: 63, lonMin: 18, lonMax: 66 };

// Last day the pre-split flat `archive:<date>` key was ever written; the
// per-pipeline `archive:<pipeline>:<date>` keys took over after this. Callers
// that fan out per-day reads across the archive can skip the legacy key for
// any date after this one — it will never exist there.
export const LEGACY_ARCHIVE_CUTOFF = "2026-08-29";

// Scope guard. A general news feed (Al Jazeera, BBC world) occasionally yields an
// unrelated military strike — US-Iran, Israel-Gaza, India-Pakistan — that still
// matches a strike event_type, so the model emits it. Keep an event only if a
// belligerent of the Russia-Ukraine war is named somewhere in its country /
// actor / headline text. Latin + Cyrillic spellings; a blank country already
// defaults to "Ukraine" below, so this only ever drops explicitly foreign events.
const IN_SCOPE =
  /ukrain|russ|belarus|donbas|donets|luhans|lugans|crimea|sevastopol|zaporizh|kherson|kharkiv|\bkyiv\b|\bkiev\b|odesa|mykolaiv|wagner|\bdpr\b|\blpr\b|moscow|kremlin|україн|росі|російс|білорус|крим|донец|луган|москв/i;

// FNV-1a — small, dependency-free, good enough for signatures / ids.
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v);
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function isoOr(v: unknown, fallback: string): string {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/** Validate raw LLM output into clean WarEvents. Malformed entries are dropped. */
export function parseEvents(raw: unknown, runId: string): WarEvent[] {
  if (!Array.isArray(raw)) return [];
  const nowIso = new Date().toISOString();
  const out: WarEvent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const type = str(rec.event_type);
    if (!TYPES.has(type)) continue;

    const headline = str(rec.headline).slice(0, 300);
    const url = str(rec.source_url);
    if (!headline) continue;
    if (!/^https?:\/\/\S+$/.test(url)) continue; // never trust an invented / empty URL

    let lat = num(rec.lat);
    let lon = num(rec.lon);
    if (
      lat === null || lon === null ||
      lat < BBOX.latMin || lat > BBOX.latMax ||
      lon < BBOX.lonMin || lon > BBOX.lonMax
    ) {
      lat = null;
      lon = null;
    }
    const geocoded_by = lat !== null ? "model" : null;

    const tier = TIERS.has(str(rec.confidence_tier))
      ? (str(rec.confidence_tier) as ConfidenceTier)
      : "wire";

    const country = str(rec.country).slice(0, 60) || "Ukraine";
    const actor_from = str(rec.actor_from).slice(0, 80);
    const actor_to = str(rec.actor_to).slice(0, 80);
    if (!IN_SCOPE.test(`${country} ${actor_from} ${actor_to} ${headline}`)) continue;

    out.push({
      // headline included so two distinct events extracted from one article,
      // of the same type at the same (or blank) place, don't collide and
      // silently overwrite one another in the live-feed merge.
      id: fnv(`${url}|${type}|${str(rec.location_name)}|${headline}`),
      first_seen_utc: nowIso,
      event_utc: isoOr(rec.event_utc, nowIso),
      event_type: type as EventType,
      headline,
      summary: str(rec.summary).slice(0, 280),
      location_name: str(rec.location_name).slice(0, 120),
      admin_region: str(rec.admin_region).slice(0, 120),
      country,
      lat,
      lon,
      geocoded_by,
      confidence_tier: tier,
      actor_from,
      actor_to,
      source_outlet: str(rec.source_outlet).slice(0, 80),
      source_url: url,
      killed_reported: num(rec.killed_reported),
      wounded_reported: num(rec.wounded_reported),
      reported_by: str(rec.reported_by).slice(0, 80),
      run_id: runId,
    });
  }
  return out;
}
