/* Ukraine War Live — map frontend. Vanilla JS + MapLibre GL, no build step. */

// The read API worker. CORS is enabled on it, so a cross-subdomain base is fine.
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
const enabled = new Set(TYPES.map(([t]) => t));

let map = null;
let mapReady = false;
let frontlineGeo = null;
let showFrontline = true;
let BLOGS = null;
let showBlogs = true;

const fc = (features) => ({ type: "FeatureCollection", features });

document.addEventListener("DOMContentLoaded", init);

function init() {
  // The "Feed" nav link points at /feed.json, which 302s to the API (web/_redirects).
  buildLegend();
  buildLayers();
  wireWindows();
  wireFrontlineToggle();
  wireBlogsToggle();
  wireSidebarToggle();
  load();
  loadFrontline();
  loadBlogs();
  setInterval(load, 5 * 60 * 1000);
  setInterval(loadFrontline, 60 * 60 * 1000);
  initMap(); // the map is a progressive enhancement; the sidebar works without it
}

function initMap() {
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
    map.on("load", () => {
      // Occupied-territory fill sits under everything else.
      map.addSource("frontline", { type: "geojson", data: fc([]) });
      map.addLayer({
        id: "frontline-fill",
        type: "fill",
        source: "frontline",
        paint: {
          "fill-color": ["match", ["get", "status"], "unknown", "#8a8f98", "#c0392b"],
          "fill-opacity": ["match", ["get", "status"], "unknown", 0.15, 0.3],
        },
      });
      map.addLayer({
        id: "frontline-line",
        type: "line",
        source: "frontline",
        paint: { "line-color": "#7a1f14", "line-width": 0.7, "line-opacity": 0.55 },
      });

      // Cluster when zoomed out: below zoom 10, markers within ~46 px merge into a
      // count badge that persists until the user zooms in past clusterMaxZoom.
      map.addSource("events", {
        type: "geojson",
        data: fc([]),
        cluster: true,
        clusterMaxZoom: 9,
        clusterRadius: 46,
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "events",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#111a2e",
          "circle-opacity": 0.95,
          "circle-stroke-color": "#f59e0b",
          "circle-stroke-width": 1.5,
          "circle-radius": ["step", ["get", "point_count"], 13, 5, 16, 15, 20, 40, 25],
          // Shifted left so an adjacent blog badge (shifted right) docks beside it
          // instead of covering it.
          "circle-translate": [-11, 0],
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "events",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["concat", "×", ["get", "point_count_abbreviated"]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#f5a623", "text-translate": [-11, 0] },
      });
      map.addLayer({
        id: "events",
        type: "circle",
        source: "events",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4.5, 8, 7, 12, 12],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.2,
          "circle-stroke-color": "#0b0f19",
          "circle-opacity": 0.92,
        },
      });
      map.on("click", "events", (e) => {
        const f = e.features[0];
        new maplibregl.Popup({ maxWidth: "320px" })
          .setLngLat(f.geometry.coordinates)
          .setHTML(popupHtml(f.properties))
          .addTo(map);
      });
      map.on("click", "clusters", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!f) return;
        map
          .getSource("events")
          .getClusterExpansionZoom(f.properties.cluster_id)
          .then((zoom) => map.easeTo({ center: f.geometry.coordinates, zoom }))
          .catch(() => {});
      });
      for (const ly of ["events", "clusters"]) {
        map.on("mouseenter", ly, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", ly, () => (map.getCanvas().style.cursor = ""));
      }

      // Independent-blog markers sit on top: hollow teal rings, and cluster into
      // their OWN teal count badges when zoomed out (separate from event clusters).
      map.addSource("blogs", {
        type: "geojson",
        data: fc([]),
        cluster: true,
        clusterMaxZoom: 9,
        clusterRadius: 40,
      });
      map.addLayer({
        id: "blog-clusters",
        type: "circle",
        source: "blogs",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#111a2e",
          "circle-opacity": 0.95,
          "circle-stroke-color": "#2dd4bf",
          "circle-stroke-width": 2,
          "circle-radius": ["step", ["get", "point_count"], 13, 5, 16, 15, 20],
          // Shifted right so it docks beside the event badge (shifted left).
          "circle-translate": [11, 0],
        },
      });
      map.addLayer({
        id: "blog-cluster-count",
        type: "symbol",
        source: "blogs",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["concat", "×", ["get", "point_count_abbreviated"]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#2dd4bf", "text-translate": [11, 0] },
      });
      map.addLayer({
        id: "blog-markers",
        type: "circle",
        source: "blogs",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 5, 10, 8],
          "circle-color": "#0b0f19",
          "circle-stroke-color": "#2dd4bf",
          "circle-stroke-width": 2.5,
          "circle-opacity": 0.95,
        },
      });
      map.on("click", "blog-markers", (e) => {
        const f = e.features[0];
        new maplibregl.Popup({ maxWidth: "300px" })
          .setLngLat(f.geometry.coordinates)
          .setHTML(blogPopupHtml(f.properties))
          .addTo(map);
      });
      map.on("click", "blog-clusters", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["blog-clusters"] })[0];
        if (!f) return;
        map
          .getSource("blogs")
          .getClusterExpansionZoom(f.properties.cluster_id)
          .then((zoom) => map.easeTo({ center: f.geometry.coordinates, zoom }))
          .catch(() => {});
      });
      for (const ly of ["blog-markers", "blog-clusters"]) {
        map.on("mouseenter", ly, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", ly, () => (map.getCanvas().style.cursor = ""));
      }

      mapReady = true;
      renderMap();
      renderFrontline();
      renderBlogs();
    });
  } catch (e) {
    console.warn("map init failed", e);
  }
}

function buildLegend() {
  const ul = document.getElementById("legend");
  ul.innerHTML = "";
  for (const k of Object.keys(TIER)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${TIER[k].c}"></span>${TIER[k].label}`;
    ul.appendChild(li);
  }
}

function buildLayers() {
  const box = document.getElementById("layers");
  box.innerHTML = "";
  for (const [t, label] of TYPES) {
    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" data-type="${t}" checked> ${label}`;
    el.querySelector("input").addEventListener("change", (ev) => {
      if (ev.target.checked) enabled.add(t);
      else enabled.delete(t);
      afterFilterChange();
    });
    box.appendChild(el);
  }

  const reset = document.getElementById("tallyreset");
  if (reset) reset.addEventListener("click", () => setEnabled(TYPES.map(([t]) => t)));
}

// Point `enabled` at exactly `types`, then sync every control and redraw.
function setEnabled(types) {
  enabled.clear();
  for (const t of types) enabled.add(t);
  afterFilterChange();
}

function afterFilterChange() {
  document.querySelectorAll('#layers input[data-type]').forEach((cb) => {
    cb.checked = enabled.has(cb.dataset.type);
  });
  const reset = document.getElementById("tallyreset");
  if (reset) reset.hidden = enabled.size >= TYPES.length;
  renderSidebar();
  renderMap();
}

// Click a tally row: isolate that type, or restore all if it's already alone.
function toggleIsolate(t) {
  if (enabled.size === 1 && enabled.has(t)) setEnabled(TYPES.map(([x]) => x));
  else setEnabled([t]);
}

function wireWindows() {
  document.querySelectorAll("#windows button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#windows button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      windowHrs = Number(b.dataset.h);
      renderSidebar();
      renderMap();
    });
  });
}

function wireFrontlineToggle() {
  const cb = document.getElementById("ly_frontline");
  if (!cb) return;
  cb.addEventListener("change", () => {
    showFrontline = cb.checked;
    if (!mapReady) return;
    const v = showFrontline ? "visible" : "none";
    for (const id of ["frontline-fill", "frontline-line"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
    }
  });
}

const BLOG_LAYERS = ["blog-markers", "blog-clusters", "blog-cluster-count"];

function setBlogVisibility() {
  if (!mapReady) return;
  const v = showBlogs ? "visible" : "none";
  for (const id of BLOG_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
}

function wireBlogsToggle() {
  const cb = document.getElementById("ly_blogs");
  if (!cb) return;
  cb.addEventListener("change", () => {
    showBlogs = cb.checked;
    setBlogVisibility();
  });
}

function wireSidebarToggle() {
  const btn = document.getElementById("sbtoggle");
  if (!btn) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("uwl.sidebar") === "collapsed";
  } catch (e) {
    /* private mode / blocked storage */
  }
  apply(collapsed);
  btn.addEventListener("click", () => apply(!document.body.classList.contains("sb-collapsed")));

  function apply(next) {
    document.body.classList.toggle("sb-collapsed", next);
    btn.textContent = next ? "<<" : ">>";
    btn.title = next ? "Open panel" : "Collapse panel";
    btn.setAttribute("aria-label", btn.title);
    try {
      localStorage.setItem("uwl.sidebar", next ? "collapsed" : "open");
    } catch (e) {
      /* ignore */
    }
    // Let the CSS width transition finish, then let MapLibre repaint at the new size.
    setTimeout(() => {
      if (map) map.resize();
    }, 220);
  }
}

async function loadBlogs() {
  try {
    const r = await fetch("/blogs.json", { cache: "no-store" });
    const d = await r.json();
    BLOGS = Array.isArray(d.blogs) ? d.blogs : [];
    renderBlogs();
  } catch (err) {
    console.warn("blogs load failed", err);
  }
}

async function load() {
  try {
    const r = await fetch(`${API_BASE}/feed.json`, { cache: "no-store" });
    const d = await r.json();
    ALL = Array.isArray(d.events) ? d.events : [];
    document.getElementById("updated").textContent = new Date(d.updated).toUTCString();
    renderSidebar();
    renderMap();
  } catch (err) {
    console.error("load failed", err);
    document.getElementById("updated").textContent = "load error";
  }
}

async function loadFrontline() {
  try {
    const r = await fetch(`${API_BASE}/frontline.json`, { cache: "no-store" });
    const d = await r.json();
    frontlineGeo = d.geojson || d;
    renderFrontline();
    const src = document.getElementById("frontline-src");
    if (src) {
      // DeepStateMap's datetime is a non-ISO string ("27.08 o 13:28"); show it as-is.
      const raw = (d.source_datetime || "").replace(/\s*o\s*/, " ").trim();
      src.textContent = raw ? `front line: DeepStateMap, ${raw} UTC` : "front line: DeepStateMap";
    }
  } catch (err) {
    console.warn("frontline load failed", err);
  }
}

function inWindow(ev) {
  if (windowHrs === 0) return true;
  return Date.parse(ev.event_utc) >= Date.now() - windowHrs * 3600 * 1000;
}

function activeEvents() {
  return ALL.filter((e) => enabled.has(e.event_type) && inWindow(e));
}

function renderSidebar() {
  const evs = activeEvents();
  document.getElementById("count").textContent = String(evs.length);

  const counts = {};
  for (const e of evs) counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  const isolated = enabled.size === 1;
  const tally = document.getElementById("tally");
  tally.innerHTML = "";
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => {
      const li = document.createElement("li");
      li.className = "click" + (isolated && enabled.has(t) ? " active" : "");
      li.dataset.type = t;
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.innerHTML = `<span>${TYPE_LABEL[t] || t}</span><b>${n}</b>`;
      li.addEventListener("click", () => toggleIsolate(t));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleIsolate(t); }
      });
      tally.appendChild(li);
    });
  const hint = document.getElementById("tallyhint");
  if (hint) hint.textContent = isolated
    ? `Isolated: ${TYPE_LABEL[[...enabled][0]] || [...enabled][0]}. Click again to show all.`
    : "Click a row to isolate that type.";

  const unmapped = evs.filter((e) => e.lat == null || e.lon == null);
  document.getElementById("nogeocount").textContent = String(unmapped.length);
  const nogeo = document.getElementById("nogeo");
  nogeo.innerHTML = "";
  if (!unmapped.length) {
    nogeo.innerHTML = '<li class="muted">All events in this window are on the map.</li>';
  }
  unmapped.slice(0, 60).forEach((e) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<a href="${escapeAttr(e.source_url)}" target="_blank" rel="noopener">${escapeHtml(e.headline)}</a>` +
      `<span class="muted"> — ${TYPE_LABEL[e.event_type] || e.event_type}</span>`;
    nogeo.appendChild(li);
  });
}

// Many events share an identical settlement-centroid coordinate (gazetteer) and
// would render exactly on top of each other. Fan any cluster of near-coincident
// events (within ~110 m) onto a small circle around the shared point so each stays
// individually visible and clickable. Events already >~110 m apart keep their real
// position untouched.
function spreadCoincident(events) {
  const groups = new Map();
  for (const e of events) {
    const key = e.lat.toFixed(3) + "," + e.lon.toFixed(3);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      out.push(pointFeature(arr[0], arr[0].lon, arr[0].lat));
      continue;
    }
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // stable ring order
    const n = arr.length;
    const r = 0.006 + 0.0016 * Math.min(n, 8); // ~0.7-1.5 km
    const latRad = (arr[0].lat * Math.PI) / 180;
    arr.forEach((e, i) => {
      const ang = (2 * Math.PI * i) / n - Math.PI / 2;
      const dLat = r * Math.sin(ang);
      const dLon = (r * Math.cos(ang)) / Math.cos(latRad);
      out.push(pointFeature(e, e.lon + dLon, e.lat + dLat, true));
    });
  }
  return out;
}

function pointFeature(e, lon, lat, spread) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      ...e,
      color: (TIER[e.confidence_tier] || TIER.wire).c,
      spread: spread ? 1 : 0,
    },
  };
}

function renderMap() {
  if (!mapReady || !map || !map.getSource("events")) return;
  const evs = activeEvents().filter((e) => e.lat != null && e.lon != null);
  map.getSource("events").setData(fc(spreadCoincident(evs)));
}

function renderFrontline() {
  if (!mapReady || !map || !map.getSource("frontline") || !frontlineGeo) return;
  map.getSource("frontline").setData(frontlineGeo);
  const v = showFrontline ? "visible" : "none";
  for (const id of ["frontline-fill", "frontline-line"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
}

// Generic version of spreadCoincident: fan items that share a ~110 m cell onto a
// small ring. Returns [{ item, lon, lat }]. `keyOf` gives a stable sort key.
function spreadPoints(items, keyOf) {
  const groups = new Map();
  for (const it of items) {
    const g = it.lat.toFixed(3) + "," + it.lon.toFixed(3);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const out = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      out.push({ item: arr[0], lon: arr[0].lon, lat: arr[0].lat });
      continue;
    }
    arr.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const n = arr.length;
    const r = 0.006 + 0.0016 * Math.min(n, 8);
    const latRad = (arr[0].lat * Math.PI) / 180;
    arr.forEach((it, i) => {
      const ang = (2 * Math.PI * i) / n - Math.PI / 2;
      out.push({
        item: it,
        lon: it.lon + (r * Math.cos(ang)) / Math.cos(latRad),
        lat: it.lat + r * Math.sin(ang),
      });
    });
  }
  return out;
}

function renderBlogs() {
  if (!mapReady || !map || !map.getSource("blogs")) return;
  const located = (BLOGS || []).filter((b) => b.lat != null && b.lon != null);
  const feats = spreadPoints(located, (b) => b.name).map(({ item, lon, lat }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      name: item.name,
      author: item.author || "",
      url: item.url,
      platform: item.platform || "",
      blurb: item.blurb || "",
      place: item.place || "",
    },
  }));
  map.getSource("blogs").setData(fc(feats));
  setBlogVisibility();
}

function blogPopupHtml(p) {
  const meta = [p.author, p.platform, p.place].filter(Boolean).map(escapeHtml).join(" &middot; ");
  return `<div class="pop">
    <h3>${escapeHtml(p.name)}</h3>
    <div class="meta">${meta}</div>
    <p>${escapeHtml(p.blurb)}</p>
    <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">Visit &rarr;</a>
  </div>`;
}

function popupHtml(p) {
  const t = TIER[p.confidence_tier] || TIER.wire;
  const when = new Date(p.event_utc).toUTCString().replace("GMT", "UTC");
  const cas =
    p.killed_reported || p.wounded_reported
      ? `<div class="meta">Reported: ${p.killed_reported || 0} killed, ${p.wounded_reported || 0} wounded — ${escapeHtml(p.reported_by || "unattributed")}</div>`
      : "";
  return `<div class="pop">
    <h3>${escapeHtml(p.headline)}</h3>
    <div class="meta">${TYPE_LABEL[p.event_type] || p.event_type} · ${escapeHtml(p.location_name || "")}${p.admin_region ? ", " + escapeHtml(p.admin_region) : ""} · ${when}</div>
    <span class="tier" style="background:${t.c}">${t.label}</span>
    <p>${escapeHtml(p.summary || "")}</p>
    ${cas}
    <div class="meta">${escapeHtml(p.actor_from || "?")} &rarr; ${escapeHtml(p.actor_to || "?")}</div>
    <a href="${escapeAttr(p.source_url)}" target="_blank" rel="noopener">${escapeHtml(p.source_outlet || "source")}</a>
  </div>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
