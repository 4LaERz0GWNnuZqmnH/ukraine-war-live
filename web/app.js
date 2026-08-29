/* Ukraine War Live — map frontend. Vanilla JS + MapLibre GL, no build step. */

const API_BASE = "https://api.ukraine.bugg.club";

const TIER = {
  high:        { c: "#22c55e", label: "High confidence (2+ wires)" },
  official_ua: { c: "#3b82f6", label: "Official — Ukraine" },
  official_ru: { c: "#a855f7", label: "Official — Russia" },
  wire:        { c: "#f59e0b", label: "News wire (single outlet)" },
  osint:       { c: "#9ca3af", label: "OSINT / geolocated" },
  state_media: { c: "#ef4444", label: "State media (unverified)" },
};

const TYPES = [
  ["missile_strike", "Missile strikes"],
  ["drone_strike", "Drone strikes"],
  ["air_defense", "Air defence"],
  ["deep_strike_ru", "Deep strikes in Russia"],
  ["naval", "Naval / Black Sea"],
  ["energy_infra", "Energy infrastructure"],
  ["ground_engagement", "Ground engagements"],
  ["territorial_change", "Territorial change"],
  ["casualty_report", "Casualty reports"],
  ["diplomatic", "Diplomacy"],
  ["pow_exchange", "POW exchanges"],
];
const TYPE_LABEL = Object.fromEntries(TYPES);

let ALL = [];
let windowHrs = 24;
let asOf = null; // null = live; otherwise epoch ms upper bound (time scrubber)
const enabled = new Set(TYPES.map(([t]) => t));
const tierOn = new Set(Object.keys(TIER));

let map = null;
let mapReady = false;
let frontlineGeo = null;
let historyGeo = null;
let showFrontline = true;
let showBlogs = true;
let showOblasts = false;
let BLOGS = null;
let OBLASTS = null;
let playTimer = null;
let pendingFocus = null; // event id from #event=… to fly to once data + map are ready

const fc = (features) => ({ type: "FeatureCollection", features });

document.addEventListener("DOMContentLoaded", init);

function applyUrlParams() {
  const qp = new URLSearchParams(location.search);
  if (qp.has("type")) {
    const set = new Set(qp.get("type").split(",").filter(Boolean));
    if (set.size) { enabled.clear(); for (const t of set) if (TYPE_LABEL[t]) enabled.add(t); }
  }
  if (qp.has("tier")) {
    const set = new Set(qp.get("tier").split(",").filter(Boolean));
    if (set.size) { tierOn.clear(); for (const t of set) if (TIER[t]) tierOn.add(t); }
  }
  const w = Number(qp.get("window"));
  if (Number.isFinite(w) && w >= 0) windowHrs = w;
  if (qp.get("frontline") === "0") showFrontline = false;
  if (qp.get("blogs") === "0") showBlogs = false;
}

function init() {
  applyUrlParams();
  pendingFocus = readEventHash();
  buildLegend();
  buildLayers();
  buildTiers();
  wireWindows();
  wireToggles();
  wireSidebarToggle();
  wireScrubber();
  wireHistoryCompare();
  wirePermalink();
  load();
  loadFrontline();
  loadBlogs();
  loadOblasts();
  loadHistoryList();
  setInterval(load, 10 * 60 * 1000);
  setInterval(loadFrontline, 3 * 60 * 60 * 1000);
  initMap();
}

/* ------------------------------------------------------------------ map ---- */

function initMap() {
  if (typeof maplibregl === "undefined") {
    showMapMsg("Map library failed to load. The panel still works.");
    return;
  }
  try {
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [33, 48.7],
      zoom: 5,
      attributionControl: {
        compact: true,
        customAttribution:
          'Front line &copy; <a href="https://deepstatemap.live" target="_blank" rel="noopener">DeepStateMap.live</a> (CC BY-NC-SA)',
      },
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("error", (e) => console.warn("map error", e && e.error));
    let painted = false;
    map.on("idle", () => (painted = true));
    setTimeout(() => {
      if (!painted && !mapReady) showMapMsg("The map is slow to load. Data is in the panel →");
    }, 9000);

    map.on("load", () => {
      hideMapMsg();

      // historical occupied area (compare) — blue-grey, sits lowest
      map.addSource("frontline-hist", { type: "geojson", data: fc([]) });
      map.addLayer({
        id: "frontline-hist-fill",
        type: "fill",
        source: "frontline-hist",
        paint: { "fill-color": "#3b6ea5", "fill-opacity": 0.28 },
      });

      // current occupied area — red
      map.addSource("frontline", { type: "geojson", data: fc([]) });
      map.addLayer({
        id: "frontline-fill",
        type: "fill",
        source: "frontline",
        paint: { "fill-color": "#c0392b", "fill-opacity": 0.3 },
      });
      map.addLayer({
        id: "frontline-line",
        type: "line",
        source: "frontline",
        paint: { "line-color": "#7a1f14", "line-width": 0.7, "line-opacity": 0.55 },
      });

      // oblast hit-test layer (near-invisible fill) + outline
      map.addSource("oblasts", { type: "geojson", data: fc([]), generateId: true });
      map.addLayer({
        id: "oblast-fill",
        type: "fill",
        source: "oblasts",
        layout: { visibility: "none" },
        paint: { "fill-color": "#8b96ad", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.18, 0.02] },
      });
      map.addLayer({
        id: "oblast-line",
        type: "line",
        source: "oblasts",
        layout: { visibility: "none" },
        paint: { "line-color": "#8b96ad", "line-width": 0.6, "line-opacity": 0.5 },
      });

      // events — clustered below zoom 10
      map.addSource("events", { type: "geojson", data: fc([]), cluster: true, clusterMaxZoom: 9, clusterRadius: 46 });
      map.addLayer({
        id: "clusters", type: "circle", source: "events", filter: ["has", "point_count"],
        paint: {
          "circle-color": "#111a2e", "circle-opacity": 0.95,
          "circle-stroke-color": "#f59e0b", "circle-stroke-width": 1.5,
          // fixed-size count pill — the "×N" already conveys magnitude, and a
          // constant radius lets it dock beside the teal blog badge without overlap
          "circle-radius": 13,
          "circle-translate": [-15, 0],
        },
      });
      map.addLayer({
        id: "cluster-count", type: "symbol", source: "events", filter: ["has", "point_count"],
        layout: { "text-field": ["concat", "×", ["get", "point_count_abbreviated"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
        paint: { "text-color": "#f5a623", "text-translate": [-15, 0] },
      });
      map.addLayer({
        id: "events", type: "circle", source: "events", filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4.5, 8, 7, 12, 12],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.2,
          "circle-stroke-color": ["case", ["==", ["get", "approx"], 1], "#e6ebf5", "#0b0f19"],
          "circle-opacity": 0.92,
        },
      });
      map.on("click", "events", (e) => {
        const p = e.features[0].properties;
        popup(e.features[0].geometry.coordinates, popupHtml(p));
        if (p.id) history.replaceState(null, "", "#event=" + p.id);
      });
      map.on("click", "clusters", (e) => zoomCluster("events", e));

      // blogs — own teal clustering, on top
      map.addSource("blogs", { type: "geojson", data: fc([]), cluster: true, clusterMaxZoom: 9, clusterRadius: 40 });
      map.addLayer({
        id: "blog-clusters", type: "circle", source: "blogs", filter: ["has", "point_count"],
        paint: {
          "circle-color": "#111a2e", "circle-opacity": 0.95,
          "circle-stroke-color": "#2dd4bf", "circle-stroke-width": 2,
          "circle-radius": 12,
          "circle-translate": [15, 0],
        },
      });
      map.addLayer({
        id: "blog-cluster-count", type: "symbol", source: "blogs", filter: ["has", "point_count"],
        layout: { "text-field": ["concat", "×", ["get", "point_count_abbreviated"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
        paint: { "text-color": "#2dd4bf", "text-translate": [15, 0] },
      });
      map.addLayer({
        id: "blog-markers", type: "circle", source: "blogs", filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 5, 10, 8], "circle-color": "#0b0f19", "circle-stroke-color": "#2dd4bf", "circle-stroke-width": 2.5, "circle-opacity": 0.95 },
      });
      map.on("click", "blog-markers", (e) => popup(e.features[0].geometry.coordinates, blogPopupHtml(e.features[0].properties)));
      map.on("click", "blog-clusters", (e) => zoomCluster("blogs", e));

      for (const ly of ["events", "clusters", "blog-markers", "blog-clusters"]) {
        map.on("mouseenter", ly, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", ly, () => (map.getCanvas().style.cursor = ""));
      }
      wireOblastHover();

      mapReady = true;
      renderMap();
      renderFrontline();
      renderHistory();
      renderBlogs();
      renderOblasts();
      maybeFocusEvent();
    });
  } catch (e) {
    console.warn("map init failed", e);
    showMapMsg("The map failed to start. Data is available in the panel.");
  }
}

function popup(lngLat, html) {
  const pp = new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(lngLat).setHTML(html).addTo(map);
  pp.on("close", () => {
    if (location.hash.indexOf("event=") !== -1) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });
  return pp;
}

/* ------------------------------------------------------------ permalinks -- */

function readEventHash() {
  const m = (location.hash || "").match(/[#&]event=([A-Za-z0-9]{4,16})/);
  return m ? m[1] : null;
}

// Called from load() and from the map "load" handler; fires once when both the
// feed and the map are ready.
function maybeFocusEvent() {
  if (!pendingFocus || !mapReady || !ALL.length) return;
  const e = ALL.find((x) => x.id === pendingFocus);
  if (!e) return;
  pendingFocus = null;
  history.replaceState(null, "", "#event=" + e.id);

  // Widen the time window if the linked event is older than the current one, so
  // its marker is actually on the map.
  const ageH = (Date.now() - Date.parse(e.event_utc)) / 3600000;
  if (windowHrs !== 0 && Number.isFinite(ageH) && ageH > windowHrs) {
    windowHrs = 0;
    document.querySelectorAll("#windows button").forEach((x) =>
      x.classList.toggle("on", Number(x.dataset.h) === 0));
    renderSidebar(); renderMap();
  }

  if (e.lat == null || e.lon == null) {
    showMapMsg("Linked event has no mapped location — find it in the list →");
    return;
  }
  map.flyTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 9) });
  map.once("moveend", () =>
    popup([e.lon, e.lat], popupHtml({ ...e, approx: e.geocoded_by === "gazetteer" ? 1 : 0 })));
}

function wirePermalink() {
  window.addEventListener("hashchange", () => {
    const id = readEventHash();
    if (id) { pendingFocus = id; maybeFocusEvent(); }
  });
  // "permalink" button inside an event popup → copy the shareable URL
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".pop .pl");
    if (!b || !b.dataset.id) return;
    const url = location.origin + location.pathname + "#event=" + b.dataset.id;
    const done = () => { b.textContent = "link copied ✓"; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      history.replaceState(null, "", "#event=" + b.dataset.id);
      done();
    }
  });
}
function zoomCluster(src, e) {
  const f = map.queryRenderedFeatures(e.point, { layers: [src === "blogs" ? "blog-clusters" : "clusters"] })[0];
  if (!f) return;
  map.getSource(src).getClusterExpansionZoom(f.properties.cluster_id)
    .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z })).catch(() => {});
}
function showMapMsg(t) { const el = document.getElementById("map-msg"); if (el) { el.textContent = t; el.hidden = false; } }
function hideMapMsg() { const el = document.getElementById("map-msg"); if (el) el.hidden = true; }

/* --------------------------------------------------------------- controls -- */

function buildLegend() {
  // legend now lives inside the Confidence filter (buildTiers)
}

function buildLayers() {
  const box = document.getElementById("layers");
  if (!box) return;
  box.innerHTML = "";
  for (const [t, label] of TYPES) {
    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" data-type="${t}" ${enabled.has(t) ? "checked" : ""}> ${label}`;
    el.querySelector("input").addEventListener("change", (ev) => {
      ev.target.checked ? enabled.add(t) : enabled.delete(t);
      afterFilterChange();
    });
    box.appendChild(el);
  }
  const reset = document.getElementById("tallyreset");
  if (reset) reset.addEventListener("click", () => setEnabled(TYPES.map(([t]) => t)));
}

function buildTiers() {
  const box = document.getElementById("tiers");
  if (!box) return;
  box.innerHTML = "";
  for (const [k, v] of Object.entries(TIER)) {
    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" data-tier="${k}" ${tierOn.has(k) ? "checked" : ""}> <span class="swatch" style="background:${v.c}"></span> ${v.label}`;
    el.querySelector("input").addEventListener("change", (ev) => {
      ev.target.checked ? tierOn.add(k) : tierOn.delete(k);
      renderSidebar(); renderMap();
    });
    box.appendChild(el);
  }
}

function setEnabled(types) {
  enabled.clear();
  for (const t of types) enabled.add(t);
  afterFilterChange();
}
function afterFilterChange() {
  document.querySelectorAll("#layers input[data-type]").forEach((cb) => (cb.checked = enabled.has(cb.dataset.type)));
  const reset = document.getElementById("tallyreset");
  if (reset) reset.hidden = enabled.size >= TYPES.length;
  renderSidebar(); renderMap();
}
function toggleIsolate(t) {
  if (enabled.size === 1 && enabled.has(t)) setEnabled(TYPES.map(([x]) => x));
  else setEnabled([t]);
}

function wireWindows() {
  document.querySelectorAll("#windows button").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.h) === windowHrs);
    b.addEventListener("click", () => {
      document.querySelectorAll("#windows button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      windowHrs = Number(b.dataset.h);
      renderSidebar(); renderMap();
    });
  });
}

function wireToggles() {
  const f = document.getElementById("ly_frontline");
  if (f) { f.checked = showFrontline; f.addEventListener("change", () => { showFrontline = f.checked; renderFrontline(); renderHistory(); }); }
  const b = document.getElementById("ly_blogs");
  if (b) { b.checked = showBlogs; b.addEventListener("change", () => { showBlogs = b.checked; setBlogVisibility(); }); }
  const o = document.getElementById("ly_oblasts");
  if (o) o.addEventListener("change", () => { showOblasts = o.checked; renderOblasts(); });
}

const BLOG_LAYERS = ["blog-markers", "blog-clusters", "blog-cluster-count"];
function setBlogVisibility() {
  if (!mapReady) return;
  const v = showBlogs ? "visible" : "none";
  for (const id of BLOG_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
}

function wireSidebarToggle() {
  const btn = document.getElementById("sbtoggle");
  if (!btn) return;
  const onPhone = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  let collapsed = onPhone; // phones start with the map full-width
  try {
    const v = localStorage.getItem("uwl.sidebar");
    if (v === "collapsed") collapsed = true;
    else if (v === "open") collapsed = false;
  } catch (e) {}
  apply(collapsed);
  btn.addEventListener("click", () => apply(!document.body.classList.contains("sb-collapsed")));
  function apply(next) {
    document.body.classList.toggle("sb-collapsed", next);
    btn.textContent = next ? "<<" : ">>";
    btn.title = next ? "Open panel" : "Collapse panel";
    btn.setAttribute("aria-label", btn.title);
    try { localStorage.setItem("uwl.sidebar", next ? "collapsed" : "open"); } catch (e) {}
    setTimeout(() => { if (map) map.resize(); }, 220);
  }
}

/* time scrubber -------------------------------------------------------------- */

function eventTimeExtent() {
  let min = Infinity, max = -Infinity;
  for (const e of ALL) {
    const t = Date.parse(e.event_utc);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min)) { const n = Date.now(); return [n - 7 * 864e5, n]; }
  return [min, Math.max(max, Date.now() - 60000)];
}

function wireScrubber() {
  const slider = document.getElementById("timeline");
  const play = document.getElementById("playbtn");
  const live = document.getElementById("livebtn");
  if (!slider) return;

  slider.addEventListener("input", () => {
    const [a, b] = eventTimeExtent();
    asOf = a + (b - a) * (Number(slider.value) / 1000);
    updateAsOfLabel();
    renderSidebar(); renderMap();
  });
  live.addEventListener("click", stopPlay);
  play.addEventListener("click", () => (playTimer ? stopPlay() : startPlay()));

  function startPlay() {
    const [a, b] = eventTimeExtent();
    if (asOf === null || asOf >= b) asOf = a;
    play.textContent = "⏸";
    playTimer = setInterval(() => {
      const [lo, hi] = eventTimeExtent();
      asOf = (asOf === null ? lo : asOf) + (hi - lo) / 120; // ~12 s to sweep
      if (asOf >= hi) { asOf = hi; stopPlay(); }
      document.getElementById("timeline").value = String(Math.round(((asOf - lo) / (hi - lo)) * 1000));
      updateAsOfLabel();
      renderSidebar(); renderMap();
    }, 100);
  }
  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    asOf = null;
    document.getElementById("playbtn").textContent = "▶";
    document.getElementById("timeline").value = "1000";
    updateAsOfLabel();
    renderSidebar(); renderMap();
  }
}
function updateAsOfLabel() {
  const el = document.getElementById("asof");
  if (!el) return;
  el.textContent = asOf === null ? "live" : new Date(asOf).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/* history compare ---------------------------------------------------------- */

async function loadHistoryList() {
  try {
    const r = await fetch(`${API_BASE}/frontline/history`, { cache: "no-store" });
    const d = await r.json();
    const sel = document.getElementById("fl-compare");
    if (!sel || !Array.isArray(d.snapshots)) return;
    for (const date of d.snapshots) {
      const days = Math.round((Date.now() - Date.parse(date)) / 864e5);
      const o = document.createElement("option");
      o.value = date;
      o.textContent = `${date}  (${days}d ago)`;
      sel.appendChild(o);
    }
  } catch (e) { console.warn("history list failed", e); }
}
function wireHistoryCompare() {
  const sel = document.getElementById("fl-compare");
  if (!sel) return;
  sel.addEventListener("change", async () => {
    if (!sel.value) { historyGeo = null; renderHistory(); return; }
    try {
      const r = await fetch(`${API_BASE}/frontline/history/${sel.value}`, { cache: "no-store" });
      const d = await r.json();
      historyGeo = d.geojson || d;
      renderHistory();
    } catch (e) { console.warn("history load failed", e); }
  });
}
function renderHistory() {
  if (!mapReady || !map.getSource("frontline-hist")) return;
  map.getSource("frontline-hist").setData(historyGeo || fc([]));
  const vis = showFrontline && historyGeo ? "visible" : "none";
  if (map.getLayer("frontline-hist-fill")) map.setLayoutProperty("frontline-hist-fill", "visibility", vis);
}

/* ---------------------------------------------------------------- loaders -- */

async function load() {
  try {
    const r = await fetch(`${API_BASE}/feed.json`, { cache: "no-store" });
    const d = await r.json();
    ALL = Array.isArray(d.events) ? d.events : [];
    setFreshness(d.meta);
    renderSidebar(); renderMap();
    maybeFocusEvent();
  } catch (err) {
    console.error("load failed", err);
    document.getElementById("freshness").textContent = "feed unavailable — retrying";
  }
}
function setFreshness(meta) {
  const el = document.getElementById("freshness");
  if (!el) return;
  const ago = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "?";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    return h < 48 ? h + "h ago" : Math.floor(h / 24) + "d ago";
  };
  if (!meta) { el.textContent = "Refreshes every 2 hours"; return; }
  el.textContent = `Last ingest — strikes ${ago(meta.strikes_run)} · ground ${ago(meta.ground_run)} · front line ${ago(meta.frontline_updated)}`;
}

async function loadFrontline() {
  try {
    const r = await fetch(`${API_BASE}/frontline.json`, { cache: "no-store" });
    const d = await r.json();
    frontlineGeo = d.geojson || d;
    renderFrontline();
    const src = document.getElementById("frontline-src");
    if (src) {
      const raw = (d.source_datetime || "").replace(/\s*o\s*/, " ").trim();
      src.textContent = raw ? `front line: DeepStateMap, ${raw} UTC` : "front line: DeepStateMap";
    }
  } catch (err) { console.warn("frontline load failed", err); }
}

async function loadBlogs() {
  try {
    const r = await fetch("/blogs.json", { cache: "no-store" });
    BLOGS = (await r.json()).blogs || [];
    renderBlogs();
  } catch (err) { console.warn("blogs load failed", err); }
}

async function loadOblasts() {
  try {
    const r = await fetch("/oblasts.json", { cache: "default" });
    OBLASTS = await r.json();
    if (mapReady && map.getSource("oblasts")) map.getSource("oblasts").setData(OBLASTS);
    renderOblasts();
  } catch (err) { console.warn("oblasts load failed", err); }
}

/* ----------------------------------------------------------------- filter -- */

function activeEvents() {
  const now = asOf === null ? Date.now() : asOf;
  const lo = windowHrs === 0 ? -Infinity : now - windowHrs * 3600 * 1000;
  return ALL.filter((e) => {
    if (!enabled.has(e.event_type)) return false;
    if (!tierOn.has(e.confidence_tier)) return false;
    const t = Date.parse(e.event_utc);
    return t >= lo && t <= now + 1000;
  });
}

/* ----------------------------------------------------------------- render -- */

function renderSidebar() {
  const countEl = document.getElementById("count");
  if (!countEl) return; // embed / no sidebar
  const evs = activeEvents();
  countEl.textContent = String(evs.length);

  const counts = {};
  for (const e of evs) counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  const isolated = enabled.size === 1;
  const tally = document.getElementById("tally");
  tally.innerHTML = "";
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    const li = document.createElement("li");
    li.className = "click" + (isolated && enabled.has(t) ? " active" : "");
    li.dataset.type = t;
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.innerHTML = `<span>${TYPE_LABEL[t] || t}</span><b>${n}</b>`;
    li.addEventListener("click", () => toggleIsolate(t));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleIsolate(t); } });
    tally.appendChild(li);
  });
  const hint = document.getElementById("tallyhint");
  if (hint) hint.textContent = isolated
    ? `Isolated: ${TYPE_LABEL[[...enabled][0]] || [...enabled][0]}. Click again to show all.`
    : "Click a row to isolate that type.";

  const unmapped = evs.filter((e) => e.lat == null || e.lon == null);
  document.getElementById("nogeocount").textContent = String(unmapped.length);
  const nogeo = document.getElementById("nogeo");
  nogeo.innerHTML = unmapped.length ? "" : '<li class="muted">All events in this window are on the map.</li>';
  unmapped.slice(0, 60).forEach((e) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<a href="${escapeAttr(e.source_url)}" target="_blank" rel="noopener">${escapeHtml(e.headline)}</a>` +
      `<span class="muted"> — ${TYPE_LABEL[e.event_type] || e.event_type}</span>`;
    nogeo.appendChild(li);
  });
}

function spreadPoints(items, keyOf) {
  const groups = new Map();
  for (const it of items) {
    const g = it.lat.toFixed(3) + "," + it.lon.toFixed(3);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const out = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) { out.push({ item: arr[0], lon: arr[0].lon, lat: arr[0].lat }); continue; }
    arr.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const n = arr.length;
    const r = 0.006 + 0.0016 * Math.min(n, 8);
    const latRad = (arr[0].lat * Math.PI) / 180;
    arr.forEach((it, i) => {
      const ang = (2 * Math.PI * i) / n - Math.PI / 2;
      out.push({ item: it, lon: it.lon + (r * Math.cos(ang)) / Math.cos(latRad), lat: it.lat + r * Math.sin(ang) });
    });
  }
  return out;
}

function renderMap() {
  if (!mapReady || !map.getSource("events")) return;
  const evs = activeEvents().filter((e) => e.lat != null && e.lon != null);
  const feats = spreadPoints(evs, (e) => e.id).map(({ item, lon, lat }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { ...item, color: (TIER[item.confidence_tier] || TIER.wire).c, approx: item.geocoded_by === "gazetteer" ? 1 : 0 },
  }));
  map.getSource("events").setData(fc(feats));
  renderOblasts();
}

function renderFrontline() {
  if (!mapReady || !map.getSource("frontline")) return;
  map.getSource("frontline").setData(frontlineGeo || fc([]));
  const v = showFrontline ? "visible" : "none";
  for (const id of ["frontline-fill", "frontline-line"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  renderHistory();
}

function renderBlogs() {
  if (!mapReady || !map.getSource("blogs")) return;
  const located = (BLOGS || []).filter((b) => b.lat != null && b.lon != null);
  const feats = spreadPoints(located, (b) => b.name).map(({ item, lon, lat }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { name: item.name, author: item.author || "", url: item.url, platform: item.platform || "", blurb: item.blurb || "", place: item.place || "" },
  }));
  map.getSource("blogs").setData(fc(feats));
  setBlogVisibility();
}

/* per-oblast event counts ------------------------------------------------- */

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInFeature(lon, lat, geom) {
  const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(lon, lat, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
let oblastCounts = {};
function renderOblasts() {
  if (!mapReady || !map.getLayer("oblast-fill")) return;
  const vis = showOblasts ? "visible" : "none";
  map.setLayoutProperty("oblast-fill", "visibility", vis);
  map.setLayoutProperty("oblast-line", "visibility", vis);
  if (!showOblasts || !OBLASTS) return;
  oblastCounts = {};
  const evs = activeEvents().filter((e) => e.lat != null);
  for (const f of OBLASTS.features) {
    let n = 0;
    for (const e of evs) if (pointInFeature(e.lon, e.lat, f.geometry)) n++;
    oblastCounts[f.properties.name] = n;
  }
}
function wireOblastHover() {
  let hoverId = null;
  const tip = document.getElementById("oblast-tip");
  map.on("mousemove", "oblast-fill", (e) => {
    if (!showOblasts) return;
    const f = e.features[0];
    if (hoverId !== null) map.setFeatureState({ source: "oblasts", id: hoverId }, { hover: false });
    hoverId = f.id;
    if (hoverId != null) map.setFeatureState({ source: "oblasts", id: hoverId }, { hover: true });
    const name = f.properties.name;
    tip.textContent = `${name}: ${oblastCounts[name] ?? 0} in window`;
    tip.hidden = false;
    tip.style.left = e.point.x + 12 + "px";
    tip.style.top = e.point.y + 12 + "px";
  });
  map.on("mouseleave", "oblast-fill", () => {
    if (hoverId !== null) map.setFeatureState({ source: "oblasts", id: hoverId }, { hover: false });
    hoverId = null;
    document.getElementById("oblast-tip").hidden = true;
  });
}

/* ---------------------------------------------------------------- popups -- */

function popupHtml(p) {
  const t = TIER[p.confidence_tier] || TIER.wire;
  const when = new Date(p.event_utc).toUTCString().replace("GMT", "UTC");
  const cas = (p.killed_reported || p.wounded_reported)
    ? `<div class="meta">Reported: ${p.killed_reported || 0} killed, ${p.wounded_reported || 0} wounded — ${escapeHtml(p.reported_by || "unattributed")} (a claim)</div>` : "";
  const loc = escapeHtml([p.location_name, p.admin_region].filter(Boolean).join(", "))
    + (p.approx === 1 ? ' <span class="muted">(approx. location)</span>' : "");
  const corr = Number(p.corroborations) >= 2
    ? `<div class="meta">Corroborated by ${Number(p.corroborations)} independent outlets</div>` : "";
  const pl = p.id
    ? `<button type="button" class="pl" data-id="${escapeHtml(String(p.id))}">permalink</button>` : "";
  return `<div class="pop">
    <h3>${escapeHtml(p.headline)}</h3>
    <div class="meta">${TYPE_LABEL[p.event_type] || p.event_type} · ${loc} · ${when}</div>
    <span class="tier" style="background:${t.c}">${t.label}</span>
    <p>${escapeHtml(p.summary || "")}</p>
    ${cas}${corr}
    <div class="meta">${escapeHtml(p.actor_from || "?")} &rarr; ${escapeHtml(p.actor_to || "?")}</div>
    <div class="popfoot">
      <a href="${escapeAttr(p.source_url)}" target="_blank" rel="noopener">${escapeHtml(p.source_outlet || "source")}</a>
      ${pl}
    </div>
  </div>`;
}
function blogPopupHtml(p) {
  const meta = [p.author, p.platform, p.place].filter(Boolean).map(escapeHtml).join(" &middot; ");
  return `<div class="pop"><h3>${escapeHtml(p.name)}</h3><div class="meta">${meta}</div><p>${escapeHtml(p.blurb)}</p>
    <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">Visit &rarr;</a></div>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  const v = String(s == null ? "" : s);
  return /^https?:\/\//i.test(v) ? escapeHtml(v).replace(/`/g, "&#96;") : "#";
}
