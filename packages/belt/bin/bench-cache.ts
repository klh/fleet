// bench-cache.ts — prompt-cache on/off baselines (bench-suite.ts --cache).
// W864: per model/leg, measure cache-miss vs cache-hit latency and record what
// the surface actually exposes — capability, per-request control, usage cache
// fields, decode tok/s, Metal memory. No fabricated toggles: a surface without
// a per-request control is measured as miss-vs-hit on the live server cache
// and meta.wire carries the honest label.
//
//   bun bench-suite.ts --cache --port 8903 [--model <id>] [--label L]
//       [--wire openai|anthropic] [--reps 12] [--sizes 2000,8000]
//       [--cache-control] [--key-env <path>] [--key-name BUCKLE_ROOT_KEY]
//
// openai wire (local :890x): legs "miss" (fresh nonce per rep) and "hit"
// (identical streamed prompt — streaming keeps the greedy response cache out
// of the picture, so only the prefix cache answers). anthropic wire (buckle
// :4101): legs "off" (no cache_control, fresh nonce) and "on" (cache_control
// ephemeral, fixed prefix — rep 1 writes, the rest read).

import { existsSync } from "node:fs";
import { AC_FLAG, buildPrompt, median, benchMeta } from "./bench-ttft.ts";
import type { Logger } from "./bench-ttft.ts";

const LOG = `${process.env.HOME}/.claude/local-llm/bench-log.ts`;

export interface CacheOpts {
	baseUrl: string;
	model: string;
	wire: "openai" | "anthropic";
	key: string | null;
	cacheControl: boolean;
	sizes: number[];
	reps: number;
	thinkingOff?: boolean;
	timeoutMs?: number;
}

export interface LegRow {
	leg: string;
	wallMs: number;
	ttftMs: number | null;
	inTok: number | null;
	outTok: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	tps: number | null;
}

type Usage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
};

/** Load KEY=VALUE lines from a 0600 env file; values never printed. */
async function envText(path: string): Promise<string> {
	return await Bun.file(path).text();
}

function parseEnv(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split("\n")
			.filter((l) => l.includes("=") && !l.startsWith("#"))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
}

const METRIC_KEYS = [
	"rapid_mlx_metal_active_memory_bytes",
	"rapid_mlx_metal_peak_memory_bytes",
	"rapid_mlx_prefix_cache_hits_total",
	"rapid_mlx_prefix_cache_misses_total",
	"rapid_mlx_prefix_cache_tokens_saved_total",
	"rapid_mlx_prefix_cache_current_bytes",
	"rapid_mlx_prefix_cache_cap_bytes",
	"rapid_mlx_model_decode_tokens_per_second_last",
] as const;

export type Metrics = Partial<Record<(typeof METRIC_KEYS)[number], number>>;

/** Prometheus text parse of the rapid-mlx gauges we report. */
export async function snapshotMetrics(baseUrl: string): Promise<Metrics | null> {
	try {
		const r = await fetch(`${baseUrl}/metrics`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!r.ok) return null;
		const t = await r.text();
		const out: Metrics = {};
		for (const line of t.split("\n")) {
			if (!line || line.startsWith("#")) continue;
			const sp = line.lastIndexOf(" ");
			if (sp < 0) continue;
			const name = line.slice(0, sp);
			if (!(METRIC_KEYS as readonly string[]).includes(name)) continue;
			const v = Number(line.slice(sp + 1));
			if (Number.isFinite(v)) out[name as (typeof METRIC_KEYS)[number]] = v;
		}
		return out;
	} catch {
		return null;
	}
}

/** One streamed/openai or blocking/anthropic completion, timed end to end. */
export async function measureOnce(
	o: CacheOpts,
	content: string,
	cacheControl: boolean,
): Promise<LegRow> {
	const t0 = performance.now();
	let ttftMs: number | null = null;
	let usage: Usage = {};
	if (o.wire === "anthropic") {
		const body: Record<string, unknown> = {
			model: o.model,
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: cacheControl
						? [
								{
									type: "text",
									text: content,
									cache_control: { type: "ephemeral" },
								},
							]
						: content,
				},
			],
		};
		const r = await fetch(`${o.baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				...(o.key ? { Authorization: `Bearer ${o.key}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
		});
		const j = (await r.json()) as { usage?: Usage; error?: unknown };
		if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
		usage = j.usage ?? {};
	} else {
		const r = await fetch(`${o.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: o.model,
				max_tokens: 8,
				temperature: 0,
				stream: true,
				stream_options: { include_usage: true },
				...(o.thinkingOff
					? { chat_template_kwargs: { enable_thinking: false } }
					: {}),
				messages: [{ role: "user", content }],
			}),
			signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
		});
		if (!res_ok(r)) throw new Error(`HTTP ${r.status}`);
		const reader = r.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const onLine = (line: string) => {
			if (!line.startsWith("data:")) return;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") return;
			let c: {
				choices?: Array<{ delta?: { content?: string } }>;
				usage?: Usage;
			};
			try {
				c = JSON.parse(data);
			} catch {
				return;
			}
			if (c.usage) usage = c.usage;
			if (ttftMs === null && c.choices?.[0]?.delta?.content)
				ttftMs = performance.now() - t0;
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				onLine(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
			}
		}
		onLine(buf);
	}
	const wallMs = performance.now() - t0;
	const inTok =
		usage.prompt_tokens ?? usage.input_tokens ?? null;
	const outTok = usage.completion_tokens ?? usage.output_tokens ?? null;
	const cacheRead = usage.cache_read_input_tokens ??
		usage.prompt_tokens_details?.cached_tokens ?? null;
	return {
		leg: "",
		wallMs,
		ttftMs,
		inTok,
		outTok,
		cacheRead,
		cacheWrite: usage.cache_creation_input_tokens ?? null,
		tps: outTok && outTok > 0 ? outTok / (wallMs / 1000) : null,
	};
}

const res_ok = (r: Response): boolean => r.ok && !!r.body;

export interface SizeResult {
	size: number;
	legs: Record<string, LegRow[]>;
	metricsBefore: Metrics | null;
	metricsAfter: Metrics | null;
}

const QUESTION = "\nHow many rows? One word.";

export async function runCacheBench(
	o: CacheOpts,
): Promise<SizeResult[]> {
	await measureOnce(o, "Say READY", false); // warmup
	const results: SizeResult[] = [];
	for (const size of o.sizes) {
		const legs: Record<string, LegRow[]> = {};
		if (o.wire === "anthropic") {
			// off: fresh nonce per rep, no cache_control — always a miss.
			legs.off = [];
			for (let r = 0; r < o.reps; r++) {
				const p = buildPrompt(size, `off-${Date.now()}-${size}-${r}`);
				legs.off.push(await measureOnce(o, p + QUESTION, false));
			}
			// on: fixed prefix + cache_control — rep 1 writes, rest read.
			legs.on = [];
			const prefix = buildPrompt(size, `on-${Date.now()}-${size}`);
			for (let r = 0; r < o.reps; r++) {
				legs.on.push(await measureOnce(o, prefix + QUESTION, true));
			}
		} else {
			// miss: fresh nonce per rep — prefix cache can never answer.
			legs.miss = [];
			for (let r = 0; r < o.reps; r++) {
				const p = buildPrompt(size, `miss-${Date.now()}-${size}-${r}`);
				legs.miss.push(await measureOnce(o, p + QUESTION, false));
			}
			// hit: one fixed streamed prompt repeated — prefix cache answers
			// every rep after the first insert; streaming keeps the response
			// cache ineligible.
			const prefix = buildPrompt(size, `hit-${Date.now()}-${size}`);
			legs.hit = [];
			for (let r = 0; r < o.reps; r++) {
				legs.hit.push(await measureOnce(o, prefix + QUESTION, false));
			}
		}
		const metricsBefore = results.at(-1)?.metricsAfter ?? null;
		results.push({
			size,
			legs,
			metricsBefore,
			metricsAfter: await snapshotMetrics(o.baseUrl),
		});
	}
	return results;
}

export function legMedians(rows: LegRow[], skipFirst = false): LegRow {
	const hitRows = skipFirst ? rows.slice(1) : rows;
	const m = (f: (r: LegRow) => number | null): number | null => {
		const v = hitRows.map(f).filter((x): x is number => x !== null);
		return v.length ? median(v) : null;
	};
	return {
		leg: rows[0]?.leg ?? "?",
		wallMs: m((r) => r.wallMs),
		ttftMs: m((r) => r.ttftMs),
		inTok: m((r) => r.inTok),
		outTok: m((r) => r.outTok),
		cacheRead: m((r) => r.cacheRead),
		cacheWrite: m((r) => r.cacheWrite),
		tps: m((r) => r.tps),
	};
}

const gb = (b: number | undefined | null): string =>
	b == null ? "?" : (b / 2** 30).toFixed(2);

export async function cacheMain(
	args: string[],
	env: { acFlag?: string; log?: Logger; baseUrl?: string } = {},
): Promise<number> {
	const get = (f: string) => {
		const i = args.indexOf(f);
		return i !== -1 ? args[i + 1] : undefined;
	};
	const port = Number(get("--port"));
	const model = get("--model") ?? "?";
	const wire = (get("--wire") ?? "openai") as "openai" | "anthropic";
	const label =
		get("--label") ?? model.replace("mlx-community/", "").slice(0, 30);
	const suite = get("--suite") ?? "cache";
	const sizes = (get("--sizes") ?? "2000")
		.split(",")
		.map(Number)
		.filter((n) => n > 0);
	const reps = Number(get("--reps") ?? 12);
	if (!port || !sizes.length || !(reps > 0)) {
		console.error(
			"usage: bench-suite.ts --cache --port N [--wire openai|anthropic] [--sizes 2000,8000] [--reps 12]",
		);
		return 1;
	}
	const flag = env.acFlag ?? AC_FLAG;
	if (!existsSync(flag)) {
		console.error(
			`refusing: bench runs need AC power — ${flag} missing (benchmarks.md law)`,
		);
		return 2;
	}
	const keyEnv = get("--key-env") ?? `${process.env.HOME}/.claude/local-llm/buckle-spoke.env`;
	const keyName = get("--key-name") ?? "BUCKLE_ROOT_KEY";
	const key = wire === "anthropic" ? parseEnv(await envText(keyEnv))[keyName] ?? null : null;
	const baseUrl = env.baseUrl ?? `http://localhost:${port}`;
	const o: CacheOpts = {
		baseUrl,
		model,
		wire,
		key,
		cacheControl: args.includes("--cache-control"),
		sizes,
		reps,
		thinkingOff: args.includes("--thinking-off"),
	};
	const meta = await benchMeta(baseUrl, port, model);
	const results = await runCacheBench(o);
	console.log(`${label} (:${port} ${wire}${o.cacheControl ? " +cc" : ""}), median of ${reps}:`);
	const log = env.log ?? ((m: string, v: number, x: Record<string, unknown>) => {
		Bun.spawnSync(["bun", LOG, "add", suite, label, m, v.toFixed(1), JSON.stringify(x)]);
	});
	for (const r of results) {
		const legNames = Object.keys(r.legs);
		// Second leg rep 1 is the cache insert, not a read — median over hits only.
		const meds = Object.fromEntries(
			legNames.map((l, i) => [l, legMedians(r.legs[l], i === 1)]),
		);
		const parts = legNames.map((l) => {
			const md = meds[l];
			const t = md.ttftMs !== null ? `ttft ${md.ttftMs.toFixed(0)}ms` : `wall ${md.wallMs.toFixed(0)}ms`;
			const cr = md.cacheRead !== null ? ` read ${md.cacheRead.toFixed(0)}` : "";
			return `${l} ${t}${cr}`;
		});
		console.log(`  ${String(r.size).padStart(6)} tok  ${parts.join("  |  ")}`);
		for (const l of legNames) {
			const md = meds[l];
			const mm = {
				...meta,
				wire,
				cache_control: o.cacheControl,
				size: r.size,
				n: reps,
				in_tok: md.inTok,
				out_tok: md.outTok,
				cache_read: md.cacheRead,
				cache_write: md.cacheWrite,
			};
			log(`cache_${l}_ms_${r.size}`, md.ttftMs ?? md.wallMs, mm);
			if (md.cacheRead !== null)
				log(`cache_read_tok_${l}_${r.size}`, md.cacheRead, mm);
			if (md.tps !== null) log(`cache_tps_${l}_${r.size}`, md.tps, mm);
		}
		const mAfter = r.metricsAfter;
		if (mAfter) {
			console.log(
				`           mem active ${gb(mAfter.rapid_mlx_metal_active_memory_bytes)}GB peak ${gb(mAfter.rapid_mlx_metal_peak_memory_bytes)}GB  pfx-cache ${gb(mAfter.rapid_mlx_prefix_cache_current_bytes)}/${gb(mAfter.rapid_mlx_prefix_cache_cap_bytes)}GB`,
			);
			log(
				`mem_active_bytes_${r.size}`,
				mAfter.rapid_mlx_metal_active_memory_bytes ?? 0,
				{ ...meta, wire, size: r.size, n: reps },
			);
		}
		if (mAfter && r.metricsBefore) {
			const d = (k: (typeof METRIC_KEYS)[number]): number =>
				(mAfter[k] ?? 0) - (r.metricsBefore![k] ?? 0);
			const saved = d("rapid_mlx_prefix_cache_tokens_saved_total");
			const hits = d("rapid_mlx_prefix_cache_hits_total");
			const misses = d("rapid_mlx_prefix_cache_misses_total");
			console.log(
				`           pfx delta: hits ${hits.toFixed(0)}  misses ${misses.toFixed(0)}  tokens saved ${saved.toFixed(0)}`,
			);
			log(`pfx_saved_delta_${r.size}`, saved, { ...meta, wire, size: r.size, n: reps });
		}
	}
	console.log("  logged to benchmarks.jsonl");
	return 0;
}
