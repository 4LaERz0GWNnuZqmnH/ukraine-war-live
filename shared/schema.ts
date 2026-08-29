// Event schema, validation, and Google Sheet mapping — shared by all workers.

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
  | "diplomatic"
  | "pow_exchange";

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
  confidence_tier: ConfidenceTier;
  actor_from: string;
  actor_to: string;
  source_outlet: string;
  source_url: string;
  killed_reported: number | null;
  wounded_reported: number | null;
  reported_by: string;
  run_id: string;
}

export const EVENT_COLUMNS = [
  "id", "first_seen_utc", "event_utc", "event_type", "headline", "summary",
  "location_name", "admin_region", "country", "lat", "lon", "confidence_tier",
  "actor_from", "actor_to", "source_outlet", "source_url", "killed_reported",
  "wounded_reported", "reported_by", "run_id",
] as const;

const TYPES = new Set<string>([
  "missile_strike", "drone_strike", "air_defense", "deep_strike_ru", "naval",
  "energy_infra", "ground_engagement", "territorial_change", "casualty_report",
  "diplomatic", "pow_exchange",
]);
const TIERS = new Set<string>([
  "high", "official_ua", "official_ru", "wire", "osint", "state_media",
]);

// Rough bounding box: Ukraine + Black Sea + western/central Russia (deep strikes
// reach refineries as far as Tatarstan). Anything outside is treated as no-geo.
const BBOX = { latMin: 40, latMax: 63, lonMin: 18, lonMax: 66 };

export function tabForType(t: EventType): "strikes" | "ground" | "casualties" | "diplomacy" {
  if (t === "casualty_report") return "casualties";
  if (t === "diplomatic" || t === "pow_exchange") return "diplomacy";
  if (t === "ground_engagement" || t === "territorial_change") return "ground";
  return "strikes";
}

export function eventToRow(e: WarEvent): string[] {
  const rec = e as unknown as Record<string, unknown>;
  return EVENT_COLUMNS.map((c) => {
    const v = rec[c];
    return v === null || v === undefined ? "" : String(v);
  });
}

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

    const tier = TIERS.has(str(rec.confidence_tier))
      ? (str(rec.confidence_tier) as ConfidenceTier)
      : "wire";

    out.push({
      id: fnv(`${url}|${type}|${str(rec.location_name)}`),
      first_seen_utc: nowIso,
      event_utc: isoOr(rec.event_utc, nowIso),
      event_type: type as EventType,
      headline,
      summary: str(rec.summary).slice(0, 280),
      location_name: str(rec.location_name).slice(0, 120),
      admin_region: str(rec.admin_region).slice(0, 120),
      country: str(rec.country).slice(0, 60) || "Ukraine",
      lat,
      lon,
      confidence_tier: tier,
      actor_from: str(rec.actor_from).slice(0, 80),
      actor_to: str(rec.actor_to).slice(0, 80),
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
