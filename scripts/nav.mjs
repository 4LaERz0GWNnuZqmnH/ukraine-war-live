// Rewrites the <nav>...</nav> block in every page to the grouped layout
// (News | Blogs | Technical | About). Run from repo root: node scripts/nav.mjs
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = [
  ["web/index.html", "map"],
  ["web/pages/chronology.html", "chronology"],
  ["web/pages/blogs.html", "blogs"],
  ["web/pages/methodology.html", "methodology"],
  ["web/pages/build.html", "build"],
  ["web/pages/about.html", "about"],
];

function nav(cur) {
  const c = (k) => (k === cur ? ' aria-current="page"' : "");
  // /feed.json 302-redirects to the API worker (see web/_redirects).
  const feed = '<a href="/feed.json">Feed</a>';
  return `<nav>
      <span class="navgroup">
        <a href="/"${c("map")}>Map</a>
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
        ${feed}
      </span>
      <span class="navsep">|</span>
      <span class="navgroup">
        <a href="/pages/about.html"${c("about")}>About</a>
      </span>
    </nav>`;
}

for (const [file, key] of PAGES) {
  const src = readFileSync(file, "utf8");
  if (!/<nav>[\s\S]*?<\/nav>/.test(src)) {
    console.error("!! no <nav> found in", file);
    process.exit(1);
  }
  const out = src.replace(/<nav>[\s\S]*?<\/nav>/, nav(key));
  if (out === src) {
    console.log("nav already current:", file);
  } else {
    writeFileSync(file, out);
    console.log("updated nav:", file);
  }
}
