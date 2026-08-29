// Minimal RSS / Atom parser. Workers have no XML DOM, so this is regex-based and
// deliberately forgiving — it only needs title, link, date, and a short summary.

export interface FeedItem {
  title: string;
  link: string;
  published: number; // epoch ms
  summary: string;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // numeric entities, decimal and hex. fromCodePoint (not fromCharCode) so
    // astral-plane characters — emoji, some CJK — survive intact.
    .replace(/&#(\d+);/g, (m, d) => cp(Number(d), m))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, h) => cp(parseInt(h, 16), m))
    .replace(/\s+/g, " ")
    .trim();
}

function cp(n: number, original: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = clean(pick(b, "title"));

    let link = clean(pick(b, "link"));
    if (!/^https?:\/\//.test(link)) {
      const href = b.match(/<link[^>]*href="([^"]+)"/i);
      if (href) link = href[1];
    }
    // Google News wraps the real URL; the <link> is still a valid dereferenceable URL.

    const dateStr =
      pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") ||
      pick(b, "dc:date") || pick(b, "date");
    let published = Date.parse(clean(dateStr));
    if (!Number.isFinite(published)) published = Date.now();

    const summary = clean(
      pick(b, "description") || pick(b, "summary") || pick(b, "content"),
    ).slice(0, 500);

    if (title && /^https?:\/\//.test(link)) {
      out.push({ title, link, published, summary });
    }
  }
  return out;
}
