// Front-line / occupied-territory polygons from DeepStateMap's public API.
// https://deepstatemap.live/api/history/last -> { id, datetime, map: FeatureCollection }
// Feature names look like "UA /// EN /// geoJSON.status.<key>"; we keep only the
// real control layers and drop DeepState's satirical "territories" (Karelia,
// Ichkeria, East Prussia, ...) and the liberated/dismissed polygons.

const KEEP: { match: string; status: "occupied" }[] = [
  { match: "geoJSON.status.occupied", status: "occupied" },
  { match: "geoJSON.territories.crimea", status: "occupied" },
  { match: "geoJSON.territories.ordlo", status: "occupied" },
];

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

export async function fetchFrontline(): Promise<FrontlineDoc> {
  const r = await fetch("https://deepstatemap.live/api/history/last", {
    headers: {
      "user-agent": "ukraine-war-live-bot/0.1 (+https://ukraine.bugg.club)",
      accept: "application/json",
    },
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`deepstatemap ${r.status}`);
  const d = (await r.json()) as { datetime?: string; map?: { features?: RawFeature[] } };
  const src = d.map?.features ?? [];

  const features: unknown[] = [];
  for (const f of src) {
    if (!f || !f.geometry) continue;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
    const name = String(f.properties?.name ?? "");
    const k = KEEP.find((x) => name.includes(x.match));
    if (!k) continue;
    features.push({
      type: "Feature",
      properties: { status: k.status },
      geometry: f.geometry,
    });
  }

  return {
    updated: new Date().toISOString(),
    source_datetime: d.datetime ?? "",
    feature_count: features.length,
    attribution: "DeepStateMap.live, CC BY-NC-SA 4.0",
    geojson: { type: "FeatureCollection", features },
  };
}
