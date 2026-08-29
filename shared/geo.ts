// Geographic helpers for deduplication.

/** Snap a coordinate to a 0.5-degree grid cell key. */
export function gridCell(lat: number | null, lon: number | null, size = 0.5): string {
  if (lat === null || lon === null) return "nogeo";
  return `${Math.floor(lat / size)}_${Math.floor(lon / size)}`;
}
