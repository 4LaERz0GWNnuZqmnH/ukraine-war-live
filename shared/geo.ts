// Geographic helpers for deduplication.

/** Snap a coordinate to a grid cell key of `size` degrees (callers pass 0.1). */
export function gridCell(lat: number | null, lon: number | null, size = 0.5): string {
  if (lat === null || lon === null) return "nogeo";
  return `${Math.floor(lat / size)}_${Math.floor(lon / size)}`;
}
