// review-tasks.ts — W792: deterministic seeded-defect task generators for the
// review arena. Each family renders a fleet-flavored, self-contained function
// (correct base), plus per-defect-class injection sites (buggy replacement
// lines). The buggy variant is the + side of the task diff — HumanEval-class
// seeded bugs with exact ground truth, reproducible from REVIEW_SEED.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bench fixture strings embed ${} as deliberate defect-injection sites
import { pick, ri, rng, type R } from "./core.ts";
import { type DefectClass, REVIEW_SEED } from "./review-core.ts";

interface Site {
	cls: DefectClass;
	anchor: string; // unique substring of the rendered base line to replace
	bug: string[]; // replacement lines (the defect); covers exactly bug.length lines at `at`
	desc: string;
}
interface Resolved extends Omit<Site, "anchor"> {
	at: number; // 0-based index into base lines
}
interface FamilyOut {
	base: string[];
	sites: Site[];
}
interface Family {
	name: string;
	file: string;
	gen: (r: R) => FamilyOut;
}

const resolveAt = (base: string[], anchor: string): number => {
	const i = base.findIndex((l) => l.includes(anchor));
	if (i < 0) throw new Error(`family anchor missing: ${anchor}`);
	return i;
};
/** Resolve anchor → line index. */
export const resolveSites = (base: string[], sites: Site[]): Resolved[] =>
	sites.map((s) => {
		const { anchor, at: _a, span: _s, ...rest } = s;
		return { ...rest, at: resolveAt(base, anchor) };
	});

// ---------------------------------------------------------------- 10 families
const FAMILIES: Family[] = [
	{
		name: "ring-buffer",
		file: "src/ring.ts",
		gen: (r) => {
			const cap = ri(r, 16, 96);
			const base = [
				"// bounded ring with backpressure — drops counted, never unbounded",
				"export function makeRing(limit: number) {",
				`\tconst buf: string[] = new Array(limit);`,
				"\tlet head = 0;",
				"\tlet dropped = 0;",
				"\treturn {",
				"\t\tpush(item: string): boolean {",
				"\t\t\tconst next = (head + 1) % limit;",
				"\t\t\tif (buf[head] !== undefined) dropped++;",
				"\t\t\tbuf[head] = item;",
				"\t\t\thead = next;",
				"\t\t\treturn true;",
				"\t\t},",
				"\t\tget size(): number {",
				"\t\t\treturn buf.filter((x) => x !== undefined).length;",
				"\t\t},",
				`\t\tget dropped(): number { return dropped; },`,
				"\t};",
				"}",
				`// ring cap in this build: ${cap}`,
			];
			return {
				base,
				sites: [
					{
						cls: "off-by-one",
						at: 0,
						span: 0,
						anchor: "const next = (head + 1) % limit;",
						bug: ["\t\t\tconst next = head % limit; // wraps one slot early"],
						desc: "advance wraps to head instead of head+1 — a slot is reused immediately and the ring loses one capacity unit",
					},
					{
						cls: "boundary",
						at: 0,
						span: 0,
						anchor: "if (buf[head] !== undefined) dropped++;",
						bug: [
							"\t\t\tif (buf[head] !== undefined && buf[next] !== undefined) dropped++;",
						],
						desc: "drop counter checks the next slot too — overcounts drops when the ring is exactly full",
					},
					{
						cls: "wrong-constant",
						at: 0,
						span: 0,
						anchor: "const buf: string[] = new Array(limit);",
						bug: [
							"\t\tconst buf: string[] = new Array(limit * 10); // inflated buffer",
						],
						desc: "buffer sized limit*10 while the modulus stays limit — the ring silently grows past its contract",
					},
				],
			};
		},
	},
	{
		name: "retry-clamp",
		file: "src/backoff.ts",
		gen: (r) => {
			const capS = ri(r, 20, 60);
			const base = [
				"// retry delay with jitter, clamped to the operator cap",
				"export function retryDelayMs(attempt: number, baseMs: number): number {",
				`\tconst cap = ${capS} * 1000;`,
				"\tconst raw = baseMs * 2 ** attempt;",
				"\tconst jitter = 1 + (Math.random() - 0.5) * 0.2;",
				"\treturn Math.min(cap, raw * jitter);",
				"}",
				"",
				"export async function withRetry<T>(",
				"\tfn: () => Promise<T>,",
				"\tattempts = 5,",
				"): Promise<T> {",
				"\tlet lastErr: unknown;",
				"\tfor (let i = 0; i < attempts; i++) {",
				"\t\ttry {",
				"\t\t\treturn await fn();",
				"\t\t} catch (e) {",
				"\t\t\tlastErr = e;",
				"\t\t\tif (i === attempts - 1) break;",
				"\t\t\tawait new Promise((res) => setTimeout(res, retryDelayMs(i, 250)));",
				"\t\t}",
				"\t}",
				"\tthrow lastErr;",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "boundary",
						at: 0,
						span: 0,
						anchor: "if (i === attempts - 1) break;",
						bug: ["\t\t\tif (i >= attempts) break; // unreachable guard"],
						desc: "retry-loop guard tests i >= attempts but the loop condition is i < attempts — the guard can never fire and the final failure is retried as attempt `attempts`",
					},
					{
						cls: "wrong-constant",
						anchor: "const cap = ",
						bug: [`\tconst cap = ${capS} * 100000; // cap inflated 100x`],
						desc: "retry-delay cap inflated 100x — callers sleep minutes instead of seconds on persistent failure (W695.6.1 shape)",
					},
					{
						cls: "inverted-condition",
						at: 0,
						span: 0,
						anchor: "const raw = baseMs * 2 ** attempt;",
						bug: ["\tconst raw = baseMs / 2 ** attempt;"],
						desc: "backoff divides instead of multiplies — retries fire immediately and hammer a failing upstream",
					},
				],
			};
		},
	},
	{
		name: "cas-claim",
		file: "src/claim.ts",
		gen: (r) => {
			const maxAttempts = ri(r, 3, 9);
			const base = [
				"// compare-and-swap claim over the work graph (single writer wins)",
				"export function claimOnce(store: {",
				"\tquery: (sql: string, ...p: unknown[]) => { run: () => void };",
				"}, item: string, sid: string): boolean {",
				"\tlet claimed = false;",
				"\tstore.query(",
				'\t\t"UPDATE items SET owner=? WHERE id=? AND owner IS NULL",',
				"\t\tsid,",
				"\t\titem,",
				"\t).run();",
				"\tconst row = store.query(",
				'\t\t"SELECT owner FROM items WHERE id=?",',
				"\t\titem,",
				"\t).get();",
				"\tif (row && row.owner === sid) claimed = true;",
				"\treturn claimed;",
				"}",
				"",
				`export function claimWithRetry(store: Parameters<typeof claimOnce>[0], item: string, sid: string) {`,
				`\tfor (let i = 0; i < ${maxAttempts}; i++) {`,
				"\t\tif (claimOnce(store, item, sid)) return i;",
				"\t}",
				"\treturn -1;",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "inverted-condition",
						at: 0,
						span: 0,
						anchor: "if (row && row.owner === sid) claimed = true;",
						bug: ["\tif (row && row.owner !== sid) claimed = true;"],
						desc: "claim success check inverted — reports success exactly when the row was claimed by someone else",
					},
					{
						cls: "dropped-check",
						at: 0,
						span: 0,
						anchor: "if (row && row.owner === sid) claimed = true;",
						bug: ["\tclaimed = true; // row presence no longer verified"],
						desc: "the owner-verification check is dropped — a lost race or missing row still reports the item claimed",
					},
					{
						cls: "wrong-var",
						at: 0,
						span: 0,
						anchor:
							'\t\t"UPDATE items SET owner=? WHERE id=? AND owner IS NULL",',
						bug: [
							'\t\t"UPDATE items SET owner=? WHERE id=? AND owner IS NULL",',
							"\t\titem,",
							"\t\tsid,",
						],
						desc: "bind order swapped: item lands in the owner column and sid in the id column — the claim writes garbage",
					},
				],
			};
		},
	},
	{
		name: "sqlite-bind",
		file: "src/bind.ts",
		gen: (r) => {
			const ttl = ri(r, 300, 3600);
			const base = [
				"// positional binding against bun:sqlite — leading nulls get dropped,",
				"// so optional scope is a 0/1 flag, never a bare null param (W-laws)",
				"export interface LaneRow {",
				"\tsid: string;",
				"\titem: string;",
				"\tmodel: string | null;",
				"}",
				"",
				"export function laneUpsert(store: {",
				"\tquery: (sql: string) => { run: (...p: unknown[]) => void };",
				"}, row: LaneRow): void {",
				"\tstore.query(",
				'\t\t"INSERT INTO lanes(sid, item, model, ttl) VALUES (?,?,?,?)",',
				"\t)(row.sid, row.item, row.model, ${ttl});",
				"}",
				"",
				"export function laneLookup(",
				"\tstore: { query: (sql: string) => { get: (...p: unknown[]) => unknown } },",
				"\tsid: string,",
				"): LaneRow | null {",
				"\tconst r = store.query(",
				'\t\t"SELECT sid, item, model FROM lanes WHERE sid=?",',
				"\t)(sid) as LaneRow | undefined;",
				"\tif (!r) return null;",
				"\treturn { sid: r.sid, item: r.item, model: r.model };",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "null-deref",
						at: 0,
						span: 0,
						anchor: "if (!r) return null;",
						bug: [
							"\treturn { sid: r.sid, item: r.item, model: r.model }; // r may be undefined",
						],
						desc: "the undefined guard on the lookup result is dropped — a miss dereferences undefined",
					},
					{
						cls: "swapped-args",
						at: 0,
						span: 0,
						anchor: ")(row.sid, row.item, row.model, ",
						bug: [
							`\t)(row.item, row.sid, row.model, ${ttl}); // sid/item swapped`,
						],
						desc: "upsert binds item and sid swapped — every row lands keyed by the wrong column",
					},
					{
						cls: "wrong-constant",
						at: 0,
						span: 0,
						anchor: ")(row.sid, row.item, row.model, ",
						bug: [
							`\t)(row.sid, row.item, row.model, ${ttl} * 100); // ttl seconds → ms`,
						],
						desc: "ttl written 100x too large — unit drift between the constant and the schema",
					},
				],
			};
		},
	},
	{
		name: "env-pin",
		file: "src/envpin.ts",
		gen: (r) => {
			const keys = ["BUCKLE_ADMIN_KEY", "BELT_ROUTER_KEY", "ZAI_API_KEY"];
			const k = pick(r, keys);
			const base = [
				"// settings env merges OVER process env (W-laws): lanes spawn with a",
				"// 0600 per-lane --settings file; the pin must win over ambient env",
				"export function pinEnv(",
				"\tambient: Record<string, string | undefined>,",
				"\tpinned: Record<string, string | undefined>,",
				"): Record<string, string> {",
				"\tconst out: Record<string, string> = {};",
				"\tfor (const [k, v] of Object.entries(ambient)) {",
				"\t\tif (v !== undefined) out[k] = v;",
				"\t}",
				"\tfor (const [k, v] of Object.entries(pinned)) {",
				"\t\tif (v !== undefined) out[k] = v;",
				"\t}",
				"\treturn out;",
				"}",
				"",
				`export function requireKey(env: Record<string, string>): string {`,
				`\tconst v = env["${k}"];`,
				'\tif (!v) throw new Error("missing key in env");',
				"\treturn v;",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "inverted-condition",
						at: 0,
						span: 0,
						anchor: "if (v !== undefined) out[k] = v;",
						bug: [
							"\t\tif (v === undefined) out[k] = v as string; // pins nothing",
						],
						desc: "pin pass assigns only when the pinned value is undefined — ambient env silently wins over the settings pin",
					},
					{
						cls: "dropped-check",
						at: 0,
						span: 0,
						anchor: 'if (!v) throw new Error("missing key in env");',
						bug: ["\treturn v as string; // missing-key throw removed"],
						desc: "missing-key guard removed — undefined key material flows into the auth chain silently",
					},
					{
						cls: "wrong-var",
						at: 0,
						span: 0,
						anchor: "if (v !== undefined) out[k] = v;",
						bug: [
							"\t\tif (v !== undefined) out[k] = String(ambient[k]); // reads the wrong source",
						],
						desc: "pin pass reads the ambient table instead of the pinned one — the settings file never wins",
					},
				],
			};
		},
	},
	{
		name: "sse-parse",
		file: "src/sse.ts",
		gen: (r) => {
			const cap = ri(r, 1024, 8192);
			const base = [
				"// NDJSON/SSE line framing over a chunked stream (streams law)",
				"export function makeFramer(onLine: (line: string) => void, maxLine: number) {",
				'\tlet buf = "";',
				"\treturn {",
				"\t\tfeed(chunk: string): void {",
				"\t\t\tbuf += chunk;",
				'\t\t\tlet i = buf.indexOf("\\n");',
				"\t\t\twhile (i >= 0) {",
				'\t\t\t\tconst line = buf.slice(0, i).replace(/\\r$/, "");',
				"\t\t\t\tbuf = buf.slice(i + 1);",
				"\t\t\t\tif (line) onLine(line);",
				'\t\t\t\ti = buf.indexOf("\\n");',
				"\t\t\t}",
				'\t\t\tif (buf.length > maxLine) throw new Error("line exceeds cap");',
				"\t\t},",
				"\t};",
				"}",
				`// framer line cap: ${cap}`,
			];
			return {
				base,
				sites: [
					{
						cls: "off-by-one",
						at: 0,
						span: 0,
						anchor: "buf = buf.slice(i + 1);",
						bug: ["\t\t\t\tbuf = buf.slice(i); // keeps the newline"],
						desc: "buffer advances to i instead of i+1 — the newline survives and every later line frames as empty",
					},
					{
						cls: "boundary",
						at: 0,
						span: 0,
						anchor:
							'if (buf.length > maxLine) throw new Error("line exceeds cap");',
						bug: [
							'\t\t\tif (buf.length >= maxLine - 1) throw new Error("line exceeds cap");',
						],
						desc: "cap check trips one byte early — a line of exactly maxLine chars aborts a healthy stream",
					},
					{
						cls: "dropped-check",
						at: 0,
						span: 0,
						anchor:
							'if (buf.length > maxLine) throw new Error("line exceeds cap");',
						bug: ["\t\t\t// cap check removed — unbounded buffer"],
						desc: "line-cap throw removed — a hostile upstream can grow the buffer unboundedly",
					},
				],
			};
		},
	},
	{
		name: "token-bucket",
		file: "src/bucket.ts",
		gen: (r) => {
			const rate = ri(r, 2, 40);
			const base = [
				"// token-bucket limiter: refill per elapsed second, burst up to capacity",
				"export class TokenBucket {",
				`\tconstructor(private capacity: number, private refillPerSec: number) {}`,
				"\tprivate tokens = this.capacity;",
				"\tprivate last = Date.now();",
				"",
				"\ttryRemove(n: number): boolean {",
				"\t\tthis.refill();",
				"\t\tif (this.tokens < n) return false;",
				"\t\tthis.tokens -= n;",
				"\t\treturn true;",
				"\t}",
				"",
				"\tprivate refill(): void {",
				"\t\tconst now = Date.now();",
				`\t\tconst gained = ((now - this.last) / 1000) * ${rate};`,
				"\t\tthis.tokens = Math.min(this.capacity, this.tokens + gained);",
				"\t\tthis.last = now;",
				"\t}",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "wrong-constant",
						at: 0,
						span: 0,
						anchor: "const gained = ((now - this.last) / 1000) * ",
						bug: [
							`\t\tconst gained = ((now - this.last) / 1000) * ${rate} * 60; // per-min rate applied per-second`,
						],
						desc: "refill applies the per-minute rate per second — bucket refills 60x too fast",
					},
					{
						cls: "boundary",
						at: 0,
						span: 0,
						anchor: "if (this.tokens < n) return false;",
						bug: [
							"\t\tif (this.tokens <= n) return false; // rejects when exactly enough",
						],
						desc: "admission check rejects when tokens === n — exact-fit requests are denied",
					},
					{
						cls: "wrong-var",
						at: 0,
						span: 0,
						anchor:
							"this.tokens = Math.min(this.capacity, this.tokens + gained);",
						bug: [
							"\t\tthis.tokens = Math.min(this.capacity, gained); // forgets the balance",
						],
						desc: "refill replaces the balance instead of adding — accumulated tokens are wiped on every refill",
					},
				],
			};
		},
	},
	{
		name: "canonical-json",
		file: "src/canon.ts",
		gen: (r) => {
			const keys = ["rid", "sha", "sid", "ts"];
			const k1 = pick(r, keys);
			const k2 = pick(
				r,
				keys.filter((x) => x !== k1),
			);
			const base = [
				"// canonical JSON: object keys sorted recursively — hashing contract",
				"export function canonical(v: unknown): string {",
				'\tif (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;',
				'\tif (v && typeof v === "object") {',
				"\t\tconst o = v as Record<string, unknown>;",
				"\t\tconst keys = Object.keys(o).sort();",
				'\t\treturn `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;',
				"\t}",
				'\treturn JSON.stringify(v) ?? "null";',
				"}",
				"",
				"export function digest(fields: Record<string, unknown>): string {",
				`\treturn canonical({ ...fields, ${k1}: fields.${k1}, ${k2}: fields.${k2} });`,
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "dropped-await",
						at: 0,
						span: 0,
						anchor:
							'if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;',
						bug: [
							'\tif (Array.isArray(v)) return `[${v.map(async (x) => canonical(x)).join(",")}]`; // promises join as [object Promise]',
						],
						desc: 'array branch maps through an async wrapper — canonical() emits "[object Promise],…" instead of values',
					},
					{
						cls: "inverted-condition",
						at: 0,
						span: 0,
						anchor: 'if (v && typeof v === "object") {',
						bug: ['\tif (!v || typeof v === "object") {'],
						desc: "object-branch guard inverted — null enters the branch and primitives fall through unstringified",
					},
					{
						cls: "wrong-var",
						at: 0,
						span: 0,
						anchor: "const keys = Object.keys(o).sort();",
						bug: [
							"\t\tconst keys = Object.keys(v).sort(); // shadows the outer keys var",
						],
						desc: "object branch reads keys from the un-narrowed value — TS-narrowing contract broken, keys can be undefined",
					},
				],
			};
		},
	},
	{
		name: "lru-cache",
		file: "src/lru.ts",
		gen: (r) => {
			const capv = ri(r, 8, 64);
			const base = [
				"// LRU cache on a Map — insertion order is recency order",
				`export class Lru<V> {`,
				`\tprivate map = new Map<string, V>();`,
				`\tconstructor(private limit: number = ${capv}) {}`,
				"",
				"\tget(key: string): V | undefined {",
				"\t\tconst v = this.map.get(key);",
				"\t\tif (v !== undefined) {",
				"\t\t\tthis.map.delete(key);",
				"\t\t\tthis.map.set(key, v);",
				"\t\t}",
				"\t\treturn v;",
				"\t}",
				"",
				"\tset(key: string, value: V): void {",
				"\t\tif (this.map.has(key)) this.map.delete(key);",
				"\t\tthis.map.set(key, value);",
				"\t\twhile (this.map.size > this.limit) {",
				"\t\t\tconst oldest = this.map.keys().next();",
				"\t\t\tif (oldest.done) break;",
				"\t\t\tthis.map.delete(oldest.value);",
				"\t\t}",
				"\t}",
				"}",
			];
			return {
				base,
				sites: [
					{
						cls: "null-deref",
						at: 0,
						span: 0,
						anchor: "const v = this.map.get(key);",
						bug: ["\t\tconst v = this.map.get(key) as V; // may be undefined"],
						desc: "get() casts the miss to V — undefined flows out typed as a value",
					},
					{
						cls: "off-by-one",
						at: 0,
						span: 0,
						anchor: "while (this.map.size > this.limit) {",
						bug: ["\t\twhile (this.map.size >= this.limit) {"],
						desc: "eviction runs at size >= limit — the cache holds limit-1 entries and thrashes at capacity",
					},
					{
						cls: "wrong-var",
						at: 0,
						span: 0,
						anchor: "if (oldest.done) break;",
						bug: ["\t\t\tif (!oldest.done) break; // eviction never fires"],
						desc: "eviction break condition inverted — the cache grows without bound",
					},
				],
			};
		},
	},
	{
		name: "promise-pool",
		file: "src/pool.ts",
		gen: (r) => {
			const width = ri(r, 2, 8);
			const base = [
				"// bounded-concurrency promise pool — width tasks in flight, results in order",
				"export async function pool<T, R>(",
				"\titems: T[],",
				"\twidth: number,",
				"\tfn: (item: T) => Promise<R>,",
				"): Promise<R[]> {",
				"\tconst results: R[] = new Array(items.length);",
				"\tlet next = 0;",
				"\tasync function worker(): Promise<void> {",
				"\t\twhile (next < items.length) {",
				"\t\t\tconst i = next++;",
				"\t\t\tresults[i] = await fn(items[i] as T);",
				"\t\t}",
				"\t}",
				`\tconst workers = Array.from({ length: Math.min(width, items.length) }, worker);`,
				"\tawait Promise.all(workers);",
				"\treturn results;",
				"}",
				`// default pool width in this build: ${width}`,
			];
			return {
				base,
				sites: [
					{
						cls: "dropped-await",
						at: 0,
						span: 0,
						anchor: "results[i] = await fn(items[i] as T);",
						bug: [
							"\t\t\tresults[i] = fn(items[i] as T) as never; // promise stored, not awaited",
						],
						desc: "worker stores the promise without await — results fill with pending promises and the pool resolves early",
					},
					{
						cls: "off-by-one",
						at: 0,
						span: 0,
						anchor: "while (next < items.length) {",
						bug: ["\t\twhile (next <= items.length) {"],
						desc: "worker loop runs one past the end — reads items[len] as undefined and throws inside the pool",
					},
					{
						cls: "resource-leak",
						at: 0,
						span: 0,
						anchor: "await Promise.all(workers);",
						bug: [
							"\tawait Promise.race([Promise.all(workers), new Promise((r) => setTimeout(r, 1000))]); // workers abandoned",
						],
						desc: "Promise.race abandons workers after 1s — pool returns while tasks still run, unawaited handles leak",
					},
				],
			};
		},
	},
];
export { FAMILIES };
export type { site };

// helper kept last so the families above stay the reading order
export function familyClasses(f: Family): DefectClass[] {
	return f.gen(rng(`${REVIEW_SEED}|probe|${f.name}`)).sites.map((s) => s.cls);
}
