// Shared admin-key check for every worker's POST /run[?key=]. Used instead of a
// plain `!==` so all five workers get the same two guarantees:
//  - constant-time compare, so a wrong key leaks no timing signal.
//  - fails CLOSED: a missing/unset RUN_KEY denies the request rather than
//    silently skipping the check (the earlier per-worker `env.RUN_KEY && ...`
//    pattern did the opposite — an unset secret meant no auth at all).
export function safeEqual(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
