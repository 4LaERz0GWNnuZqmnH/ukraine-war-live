// Rewrites the <nav>...</nav> block in every page to the grouped layout
// (News | Blogs | Technical | About). Run from repo root: node scripts/nav.mjs
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = [
  ["web/index.html", "map"],
  ["web/pages/today.html", "today"],
  ["web/pages/chronology.html", "chronology"],
  ["web/pages/blogs.html", "blogs"],
  ["web/pages/methodology.html", "methodology"],
  ["web/pages/build.html", "build"],
  ["web/pages/status.html", "status"],
  ["web/pages/about.html", "about"],
  ["web/pages/donate.html", "donate"],
];

function nav(cur) {
  const c = (k) => (k === cur ? ' aria-current="page"' : "");
  const feed = cur === "map" ? '<a href="/feed.json">Feed</a>' : '<a href="/feed.json">Feed</a>';
  return `<nav>
      <span class="navgroup">
        <a href="/"${c("map")}>Map</a>
        <a href="/pages/today.html"${c("today")}>Today</a>
        <a href="/pages/chronology.html"${c("chronology")}>Chronology</a>
      </span>
      <span class="navsep">|</span>
      <span class="navgroup">
        <a href="/pages/blogs.html"${c("blogs")}>Blogs</a>
      </span>
      <span class="navsep">|</span>
      <span class="navgroup">
        <a href="/pages/methodology.html"${c("methodology")}>Methodology</a>
        <a href="/pages/build.html"${c("build")}>How it's built</a>
        <a href="/pages/status.html"${c("status")}>Status</a>
        ${feed}
      </span>
      <span class="navsep">|</span>
      <span class="navgroup">
        <a href="/pages/about.html"${c("about")}>About</a>
        <a href="/pages/donate.html"${c("donate")}>Donate</a>
      </span>
    </nav>`;
}

for (const [file, key] of PAGES) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    console.error("!! missing", file);
    process.exit(1);
  }
  if (!/<nav>[\s\S]*?<\/nav>/.test(src)) {
    console.error("!! no <nav> in", file);
    process.exit(1);
  }
  const out = src.replace(/<nav>[\s\S]*?<\/nav>/, nav(key));
  if (out === src) console.log("nav already current:", file);
  else {
    writeFileSync(file, out);
    console.log("updated nav:", file);
  }
}
