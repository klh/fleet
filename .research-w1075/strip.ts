// W1075: strip Jepsen analysis HTML to plain text for reading
const h = await Bun.file(".research-w1075/jepsen.html").text();
const m = h.match(/<article[\s\S]*?<\/article>/);
const t = (m ? m[0] : h)
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, "\n")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&#39;/g, String.fromCharCode(39))
  .replace(/&quot;/g, String.fromCharCode(34))
  .replace(/\n{2,}/g, "\n")
  .trim();
await Bun.write(".research-w1075/jepsen.txt", t);
console.log(String(t.length));
