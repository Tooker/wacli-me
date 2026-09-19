#!/usr/bin/env node
// Static builder: site/pages/**.html (body fragments) + site/layout.html -> web/
//
// A page fragment starts with one meta line:
//   <!--meta {"title":"…","description":"…","nav":"docs"}-->
// Everything after it is the page body, dropped into {{body}}.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = path.join(root, "site", "pages");
const assetsDir = path.join(root, "site", "assets");
const outDir = path.join(root, "web");
const SITE_URL = process.env.WACLI_ME_ISSUER || "https://wacli.me";
const layout = fs.readFileSync(path.join(root, "site", "layout.html"), "utf8");

const NAV_KEYS = ["docs", "use-cases", "open-source", "pricing", "blog"];

// Assets are served with max-age=300 and sit behind Cloudflare, so a plain
// /style.css keeps serving the previous deploy's file — the new markup arrives
// (HTML is no-cache) while its stylesheet does not. Stamping the content hash
// into the URL makes every change a new URL, so no cache can hold it back.
const assetVersions = new Map();
function versioned(html) {
  for (const [name, hash] of assetVersions) {
    html = html.replaceAll(`"/${name}"`, `"/${name}?v=${hash}"`);
  }
  return html;
}

// /docs/tools.html -> /docs/tools, /index.html -> /
function urlPath(rel) {
  const clean = rel.replace(/\\/g, "/").replace(/\.html$/, "");
  if (clean === "index") return "/";
  if (clean.endsWith("/index")) return "/" + clean.slice(0, -"/index".length);
  return "/" + clean;
}

// Search engines and assistants both reward pages that answer a question in
// machine-readable form. The FAQ already is one: every h3 a question, the
// paragraphs after it the answer.
function faqJsonLd(body) {
  const items = [];
  const re = /<h3>([\s\S]*?)<\/h3>\s*((?:<p>[\s\S]*?<\/p>\s*)+)/g;
  let match;
  while ((match = re.exec(body))) {
    const question = strip(match[1]);
    const answer = strip(match[2]);
    if (question && answer) items.push({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } });
  }
  if (!items.length) return "";
  return script({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items });
}

function strip(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function script(data) {
  return '<script type="application/ld+json">' + JSON.stringify(data) + "</script>";
}

function homeJsonLd(meta) {
  return script([
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "wacli.me",
      alternateName: ["hosted wacli", "WhatsApp MCP server"],
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      url: SITE_URL,
      description: meta.description,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      isBasedOn: "https://github.com/openclaw/wacli",
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "wacli.me",
      url: SITE_URL,
    },
  ]);
}

function walk(dir, base = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(base, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(abs, rel);
    return entry.name.endsWith(".html") ? [rel] : [];
  });
}

function render(rel) {
  const raw = fs.readFileSync(path.join(pagesDir, rel), "utf8");
  const metaMatch = raw.match(/^<!--meta\s+([\s\S]*?)-->\s*/);
  if (!metaMatch) throw new Error(`${rel}: missing <!--meta {...}--> header`);
  const meta = JSON.parse(metaMatch[1]);
  const body = raw.slice(metaMatch[0].length).trimEnd();

  const url = urlPath(rel);
  const jsonld =
    url === "/" ? homeJsonLd(meta) : url === "/faq" ? faqJsonLd(body) : "";

  let html = layout
    .replaceAll("{{canonical}}", SITE_URL + url)
    .replaceAll("{{jsonld}}", jsonld)
    .replaceAll("{{title}}", meta.title)
    .replaceAll("{{ogtitle}}", meta.ogtitle || meta.title)
    .replaceAll("{{description}}", meta.description)
    .replaceAll("{{head}}", meta.head || "")
    .replaceAll("{{scripts}}", meta.scripts || "")
    .replaceAll("{{body}}", body);

  for (const key of NAV_KEYS) {
    html = html.replaceAll(`{{nav_${key}}}`, meta.nav === key ? ' aria-current="page"' : "");
  }

  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, versioned(html));
  return rel;
}

fs.mkdirSync(outDir, { recursive: true });

// Assets first: the pages need their hashes.
const copied = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).map((name) => {
      const from = path.join(assetsDir, name);
      fs.copyFileSync(from, path.join(outDir, name));
      if (/\.(css|js)$/.test(name)) {
        const hash = crypto.createHash("sha1").update(fs.readFileSync(from)).digest("hex").slice(0, 8);
        assetVersions.set(name, hash);
      }
      return name;
    })
  : [];

const built = walk(pagesDir).map(render).sort();

// Sitemap: every page except the 404, which must never be offered as a target.
const urls = built
  .filter((rel) => !rel.endsWith("404.html"))
  .map((rel) => `  <url><loc>${SITE_URL}${urlPath(rel)}</loc></url>`)
  .join("\n");
fs.writeFileSync(
  path.join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
);

console.log(`built ${built.length} page(s): ${built.join(", ")}`);
console.log(`sitemap: ${built.length - 1} url(s)`);
console.log(`copied ${copied.length} asset(s): ${copied.join(", ")}`);
