// Fire-and-forget page-view beacon. Counted server-side by uwl-api (/hit) into
// Cloudflare Analytics Engine. No cookies, no localStorage, no identifiers kept
// on the client; the server derives a daily-rotating hash it can't reverse.
try {
  var u = "https://api.ukraine.bugg.club/hit?p=" + encodeURIComponent(location.pathname);
  if (!(navigator.sendBeacon && navigator.sendBeacon(u))) {
    fetch(u, { method: "POST", keepalive: true, mode: "no-cors" });
  }
} catch (e) {
  /* never let analytics break the page */
}
