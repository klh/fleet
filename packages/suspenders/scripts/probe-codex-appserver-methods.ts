// W1052.2.2 probe: extract app-server JSON-RPC method names from the local
// codex binary (ground truth for the managed-turn launch design).
import { readFileSync } from "node:fs";

const bin = process.argv[2] ?? `${process.env.HOME}/.local/bin/codex`;
const buf = readFileSync(bin);
const text = buf.toString("latin1");
const rx = /(?:thread|turn)\/[a-zA-Z]+/g;
const found = new Map<string, number>();
for (const m of text.matchAll(rx))
	found.set(m[0], (found.get(m[0]) ?? 0) + 1);
const sorted = [...found.entries()].sort((a, b) => b[1] - a[1]);
for (const [name, n] of sorted) console.log(`${n}\t${name}`);
console.error(`binary: ${bin} (${buf.length} bytes, ${sorted.length} distinct)`);
