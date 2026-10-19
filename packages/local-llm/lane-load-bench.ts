// lane-load-bench.ts — W452, re-integrated W782.2.1 (parked/W452 @6e74115e):
// model residency + generation concurrency measured under REAL lane load —
// cold/warm TTFT, quality, p95 at the swarm's actual admission concurrency
// (registry maxInflight, W504), not idle-bench wins. Streaming OpenAI wire
// straight to each specialist port; the :4000 router is NOT the test subject
// here (that seam is benchmarked in belt).
//
// usage: bun lane-load-bench.ts [--roles code,general] [--rounds N]
//        [--concurrency N] [--max-tokens N] [--json]
//   rows append NDJSON to ~/.claude-insights/lane-load-bench.ndjson;
//   summary table on stdout. Exit 1 when no port answered.
//
// A cold row is honest: the first request to a port that was not resident
// at bench start includes model load. Warm rows follow. Quality validators
// are deterministic (exact format, JSON shape, arithmetic) — a graded pass
// rate, not an LLM judge.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { endpointPassed } from "./health.ts";
import { SPECIALISTS, type Specialist } from "./registry.ts";

export interface BenchRow {
	port: number;
	model: string;
	role: string;
	alias: string;
	concurrency: number;
	round: number;
	slot: number;
	cold: boolean;
	resident_before: boolean;
	ttft_ms: number | null;
	total_ms: number;
	chunks: number;
	ok: boolean;
	quality: "pass" | "fail" | "n/a";
	error?: string;
}

export const NDJSON_PATH = `${homedir()}/.claude-insights/lane-load-bench.ndjson`;

// nearest-rank percentile on a sorted-ascending list
export function pctl(sorted: number[], p: number): number | null {
	if (!sorted.length) return null;
	const i = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[i];
}

// ---- quality validators (deterministic) -----------------------------------
export interface Prompt {
	id: string;
	text: string;
	maxTokens: number;
	grade: (out: string) => boolean;
}

const lowerIncludes = (hay: string, needle: string): boolean =>
	hay.toLowerCase().includes(needle.toLowerCase());

// tuple type: index access stays Prompt without non-null assertions
export const PROMPTS: [Prompt, ...Prompt[]] = [
	{
		id: "format-line",
		text: "Reply with EXACTLY one line and nothing else: STATUS=ok",
		maxTokens: 16,
		grade: (out) => /^STATUS=ok\s*$/.test(out.trim()),
	},
	{
		id: "json-shape",
		text: 'Reply with EXACTLY this JSON and nothing else: {"ok":true,"n":7}',
		maxTokens: 32,
		grade: (out) => {
			const start = out.indexOf("{");
			const end = out.lastIndexOf("}");
			if (start < 0 || end <= start) return false;
			try {
				const v = JSON.parse(out.slice(start, end + 1)) as {
					ok?: boolean;
					n?: number;
				};
				return v.ok === true && v.n === 7;
			} catch {
				return false;
			}
		},
	},
	{
		id: "count-letters",
		text: 'How many letters does the word "fleet" have? Reply with just the digit.',
		maxTokens: 8,
		grade: (out) => /\b5\b/.test(out),
	},
	{
		id: "danish",
		text: 'Oversæt til dansk (svar KUN med oversættelsen): "The fleet moves as one."',
		maxTokens: 48,
		grade: (out) =>
			out.trim().length > 0 && !lowerIncludes(out, "the fleet"),
	},
];

// ---- streaming request: TTFT + chunk/quality capture ----------------------
export interface GenResult {
	ttftMs: number | null;
	totalMs: number;
	chunks: number;
	text: string;
	ok: boolean;
	error?: string;
}

export async function generateOnce(
	port: number,
	model: string,
	prompt: Prompt,
	now: () => number = Date.now,
): Promise<GenResult> {
	const t0 = now();
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				stream: true,
				max_tokens: prompt.maxTokens,
				messages: [{ role: "user", content: prompt.text }],
			}),
		});
		if (!res.ok) {
			await res.body?.cancel();
			return failGen(now() - t0, `HTTP ${res.status}`);
		}
		return await readStream(res, prompt, t0, now);
	} catch (error) {
		return failGen(
			now() - t0,
			error instanceof Error ? error.message : String(error),
		);
	}
}

const failGen = (totalMs: number, error: string): GenResult => ({
	ttftMs: null,
	totalMs,
	chunks: 0,
	text: "",
	ok: false,
	error,
});

// SSE parse: `data: {...}` lines; TTFT = first content delta
export async function readStream(
	res: Response,
	prompt: Prompt,
	t0: number,
	now: () => number = Date.now,
): Promise<GenResult> {
	const reader = res.body?.getReader();
	if (!reader) return failGen(now() - t0, "no body");
	return scanSse(t0, now, reader);
}

async function scanSse(
	t0: number,
	now: () => number,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<GenResult> {
	const dec = new TextDecoder();
	let buf = "";
	let text = "";
	let chunks = 0;
	let ttft: number | null = null;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const out = consumeLines(buf);
		buf = out.rest;
		if (ttft === null && out.ttft) ttft = now() - t0;
		chunks += out.chunks;
		text += out.text;
	}
	return { ttftMs: ttft, totalMs: now() - t0, chunks, text, ok: chunks > 0 };
}

// pure SSE line consumer (exported for tests): data lines → text + chunks
export function consumeLines(
	buf: string,
): { rest: string; text: string; chunks: number; ttft: boolean } {
	const parts = buf.split("\n");
	const rest = parts.pop() ?? ""; // partial tail held back
	let text = "";
	let chunks = 0;
	let ttft = false;
	for (const line of parts) {
		const t = line.trim();
		if (!t.startsWith("data:")) continue;
		const payload = t.slice(5).trim();
		if (payload === "[DONE]") continue;
		try {
			const j = JSON.parse(payload) as {
				choices?: { delta?: { content?: string } }[];
			};
			const piece = j.choices?.[0]?.delta?.content;
			if (typeof piece === "string" && piece.length > 0) {
				ttft = true;
				chunks += 1;
				text += piece;
			}
		} catch {
			// keep-alive or partial line — not a generation failure
		}
	}
	return { rest, text, chunks, ttft };
}

// ---- residency probe (outside-process: the port answers or it is not up) ---
export async function probeResidency(s: Specialist): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${s.port}/health`, {
			signal: AbortSignal.timeout(2000),
			redirect: "manual",
		});
		return await endpointPassed(res);
	} catch {
		return false; // refused/timeout — nothing resident on the port
	}
}

export async function benchPort(
	s: Specialist,
	concurrency: number,
	rounds: number,
	residentBefore: boolean,
): Promise<BenchRow[]> {
	const rows: BenchRow[] = [];
	for (let round = 1; round <= rounds; round++) {
		const slots: Prompt[] = Array.from(
			{ length: concurrency },
			(_, i) => PROMPTS[i % PROMPTS.length],
		);
		const results = await Promise.all(
			slots.map((p) => generateOnce(s.port, s.model, p)),
		);
		for (const [i, r] of results.entries()) {
			const p = slots[i];
			if (!p) continue;
			rows.push(mkRow(s, p, r, i, concurrency, round, residentBefore));
		}
	}
	return rows;
}

const mkRow = (
	s: Specialist,
	prompt: Prompt,
	r: GenResult,
	slot: number,
	concurrency: number,
	round: number,
	residentBefore: boolean,
): BenchRow => ({
	port: s.port,
	model: s.model,
	role: s.role,
	alias: s.alias,
	round,
	slot,
	concurrency,
	cold: !residentBefore && round === 1,
	resident_before: residentBefore,
	ttft_ms: r.ttftMs,
	total_ms: r.totalMs,
	chunks: r.chunks,
	ok: r.ok,
	quality: r.ok ? (prompt.grade(r.text) ? "pass" : "fail") : "n/a",
	...(r.error ? { error: r.error } : {}),
});

// ---- summary ----------------------------------------------------------------
export function summarize(rows: BenchRow[]): string[] {
	const lines: string[] = [];
	const ports = [...new Set(rows.map((r) => r.port))];
	for (const port of ports) {
		const rs = rows.filter((r) => r.port === port);
		const cold = rs.find((r) => r.cold && r.ttft_ms !== null);
		const warmTtft = rs
			.filter((r) => !r.cold && r.ttft_ms !== null)
			.map((r) => r.ttft_ms)
			.filter((x): x is number => x !== null)
			.sort((a, b) => a - b);
		const graded = rs.filter((r) => r.quality !== "n/a");
		const passed = graded.filter((r) => r.quality === "pass");
		const model = rs[0]?.model ?? "?";
		const conc = rs[0]?.concurrency ?? 0;
		const gen = rs
			.filter((r) => r.total_ms > 0)
			.map((r) => r.total_ms)
			.sort((a, b) => a - b);
		lines.push(
			`port ${port} (${model}) c=${conc}: ` +
				`cold_ttft=${cold?.ttft_ms ?? "—"}ms ` +
				`warm_ttft p50/p95=${pctl(warmTtft, 50) ?? "—"}/${pctl(warmTtft, 95) ?? "—"}ms ` +
				`gen_p95=${pctl(gen, 95) ?? "—"}ms ` +
				`quality=${passed.length}/${graded.length}`,
		);
	}
	return lines;
}

// ---- main (guarded: importable by tests) ------------------------------------
export const arg = (name: string): string | null => {
	const i = process.argv.indexOf(name);
	return i > 0 ? (process.argv[i + 1] ?? null) : null;
};

export function appendRows(rows: BenchRow[]): void {
	if (!rows.length) return;
	mkdirSync(`${homedir()}/.claude-insights`, { recursive: true, mode: 0o700 });
	const body = rows.map((r) => JSON.stringify(r)).join("\n");
	appendFileSync(NDJSON_PATH, `${body}\n`, { mode: 0o600 });
}

export const benchConcurrency = (s: Specialist): number => s.maxInflight ?? 4;

if (import.meta.main) {
	const roles = (arg("--roles") ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	const rounds = Number(arg("--rounds") ?? 3);
	const concOverride = Number(arg("--concurrency") ?? 0);
	const targets = SPECIALISTS.filter(
		(s) =>
			!roles.length ||
			roles.includes(s.role) ||
			roles.includes(s.alias) ||
			roles.includes(String(s.port)),
	);
	if (!targets.length) {
		console.error(`no specialist matches --roles ${roles.join(",")}`);
		process.exit(2);
	}
	const all: BenchRow[] = [];
	for (const s of targets) {
		const resident = await probeResidency(s);
		const conc = concOverride > 0 ? concOverride : benchConcurrency(s);
		console.log(
			`${resident ? "resident" : "NOT resident"}: ${s.label} :${s.port} ` +
				`(${s.tier} tier, c=${conc}) — benching`,
		);
		const rows = await benchPort(s, conc, rounds, resident);
		all.push(...rows);
		for (const line of summarize(rows)) console.log(`  ${line}`);
	}
	appendRows(all);
	const anyUp = all.some((r) => r.ok);
	if (!anyUp) process.exit(1);
}
