// one-shot: strip fetched HTML pages to text for the W1134 survey
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

for (const f of readdirSync(import.meta.dir)) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(new URL(f, import.meta.url), "utf8");
  const t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, a) => a[i - 1] !== s)
    .join("\n");
  writeFileSync(new URL(f.replace(/\.html$/, ".txt"), import.meta.url), t);
}
console.log("ok");
