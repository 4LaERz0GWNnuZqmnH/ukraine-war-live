// Front-line / occupied-territory polygons from DeepStateMap's public API.
//   /api/history/last            -> { datetime, map: { features:[...] } }  (current)
//   /api/history/public          -> [ { id, createdAt, datetime }, ... ]   (snapshot list)
//   /api/history/<id>/geojson    -> { type, features:[...] }               (one snapshot)
// Feature names look like "UA /// EN /// geoJSON.status.<key>"; keep only the real
// control layers and drop DeepState's satirical territories + liberated polygons.

const KEEP = ["geoJSON.status.occupied", "geoJSON.territories.crimea", "geoJSON.territories.ordlo"];

export interface FrontlineDoc {
  updated: string;
  source_datetime: string;
  feature_count: number;
  attribution: string;
  geojson: { type: "FeatureCollection"; features: unknown[] };
}

interface RawFeature {
  type: "Feature";
  geometry?: { type: string; coordinates: unknown };
  properties?: { name?: string };
}

const UA = "ukraine-war-live-bot/0.1 (+https://ukraine.bugg.club)";

function filterFeatures(src: RawFeature[]): unknown[] {
  const out: unknown[] = [];
  for (const f of src) {
    if (!f || !f.geometry) continue;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
    const name = String(f.properties?.name ?? "");
    if (!KEEP.some((k) => name.includes(k))) continue;
    out.push({ type: "Feature", properties: { status: "occupied" }, geometry: f.geometry });
  }
  return out;
}

function toDoc(features: unknown[], sourceDatetime: string): FrontlineDoc {
  return {
    updated: new Date().toISOString(),
    source_datetime: sourceDatetime,
    feature_count: features.length,
    attribution: "DeepStateMap.live, CC BY-NC-SA 4.0",
    geojson: { type: "FeatureCollection", features },
  };
}

/** The current control map. */
export async function fetchFrontline(): Promise<FrontlineDoc> {
  const r = await fetch("https://deepstatemap.live/api/history/last", {
    headers: { "user-agent": UA, accept: "application/json" },
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`deepstatemap last ${r.status}`);
  const d = (await r.json()) as { datetime?: string; map?: { features?: RawFeature[] } };
  return toDoc(filterFeatures(d.map?.features ?? []), d.datetime ?? "");
}

export interface HistoryEntry {
  id: number;
  createdAt: string;
  datetime: string;
}

/** List of available historical snapshots (newest last). */
export async function fetchHistoryList(): Promise<HistoryEntry[]> {
  const r = await fetch("https://deepstatemap.live/api/history/public", {
    headers: { "user-agent": UA, accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`deepstatemap history ${r.status}`);
  const d = (await r.json()) as unknown;
  const arr = Array.isArray(d) ? d : ((d as { result?: unknown[] }).result ?? []);
  return (arr as HistoryEntry[]).filter((x) => x && x.id && x.createdAt);
}

/** One historical snapshot by its DeepState id. */
export async function fetchFrontlineAt(id: number, datetime = ""): Promise<FrontlineDoc> {
  const r = await fetch(`https://deepstatemap.live/api/history/${id}/geojson`, {
    headers: { "user-agent": UA, accept: "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`deepstatemap snapshot ${id} ${r.status}`);
  const d = (await r.json()) as { features?: RawFeature[]; map?: { features?: RawFeature[] } };
  const feats = d.features ?? d.map?.features ?? [];
  return toDoc(filterFeatures(feats), datetime);
}
