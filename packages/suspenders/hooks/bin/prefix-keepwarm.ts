// prefix-keepwarm.ts — W623 dispatch prefix-cache keepwarm. Every lane
// shares one stable request prefix (harness preamble + AGENTS.md as tools +
// system blocks); idle gaps evict it and every dispatch brief re-pays the
// full prefix at cache-write rates. Evidence 2026-10-11: 48h of spoke
// ledger shows 4.46M input tokens with ZERO cached (cache_r=576, one
// watchdog) while a 2-pass probe through the buckle front proved z.ai
// implicit caching — pass 2 read 8577 of 8630 prefix tokens at ~5x lower
// latency. Pattern: llm-keepwarm.ts (one pass, then exit; the launchd job
// re-runs every 240s). Three verbs:
//   (default)  one warm pass — replay the captured prefix + a nonce user
//              message (nonce: the specialist response-cache must not
//              answer), max_tokens: 1, through the buckle front /w/<SID>
//              so route_audit attributes it.
//   --capture  run the capture client (default: claude -p) against a
//              one-shot loopback listener; the FIRST /v1/messages body's
//              {model, tools, system} is the stable prefix — saved verbatim
//              (cache_control markers included) to the 0600 capture file,
//              request bytes still forwarded to the real front so the
//              capture client works.
//   --report   cache telemetry from the spoke ledger (route_audit per lane,
//              router_usage per model) — the before/after measurement.
// Auth: the session-enrollment shape (scripts/lib/lane-auth.ts) — a scoped
// bksk_ key named prefix-keepwarm, reuse window inside the 24h TTL, 0600
// meta+settings files under the runtime home. The key is never logged.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { usageFromAnthropic, type Usage } from "../../../buckle/src/usage.ts";
import {
	adminKey,
	BUCKLE_FRONT,
	enrollSessionKey,
} from "../../scripts/lib/lane-auth.ts";

/** The keepwarm's lane identity on the front (/w/<SID>, route_audit.lane). */
export const PREFIX_SID = "prefix-keepwarm";

export const runtimeHome = (): string =>
	process.env.PREFIX_KEEPWARM_HOME ?? join(homedir(), ".claude", "local-llm");

export const prefixCachePath = (): string =>
	process.env.PREFIX_CACHE_PATH ?? join(runtimeHome(), "prefix-cache.json");

/** The captured stable prefix, verbatim from a real lane request. system is
 *  the wire shape (string or block array) — replayed byte-identical. */
export interface CapturedPrefix {
	capturedAt: number;
	model: string;
	tools: unknown[];
	system: unknown;
}

const isPrefix = (v: unknown): v is CapturedPrefix => {
	if (!v || typeof v !== "object") return false;
	const p = v as Partial<CapturedPrefix>;
	return (
		typeof p.model === "string" &&
		p.model.length > 0 &&
		Array.isArray(p.tools) &&
		p.system !== undefined
	);
};

/** Read + validate the capture file; null when absent/corrupt (fail-safe:
 *  a warm pass skips, it never invents a prefix). */
export function loadPrefix(path = prefixCachePath()): CapturedPrefix | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPrefix(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Persist a captured prefix, 0600 — the prefix is request bytes, not a
 *  secret, but it rides the machine-level config dir (config-over-code). */
export function savePrefix(
	prefix: CapturedPrefix,
	path = prefixCachePath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(prefix, null, 2)}\n`, { mode: 0o600 });
}

/** The stable prefix from a lane request body — model + tools + system,
 *  messages excluded (they are per-turn). null when the body has no model. */
export function extractPrefix(body: unknown): CapturedPrefix | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	if (typeof b.model !== "string" || b.model.length === 0) return null;
	return {
		capturedAt: Date.now(),
		model: b.model,
		tools: Array.isArray(b.tools) ? b.tools : [],
		system: b.system ?? "",
	};
}

/** The warm request: captured prefix + ONE nonce user message. The nonce
 *  keeps response caches from answering (llm-keepwarm's lesson). */
export function warmBody(
	prefix: CapturedPrefix,
	nonce: number,
): Record<string, unknown> {
	return {
		model: prefix.model,
		max_tokens: 1,
		tools: prefix.tools,
		system: prefix.system,
		messages: [{ role: "user", content: `warm ${nonce}` }],
	};
}

export interface WarmResult {
	verdict: "pass" | "fail" | "skipped";
	why: string;
	ms: number;
	usage: Usage | null;
}

/** One warm pass: the captured prefix through the front's /w/<SID>. usage
 *  tells the economics — cache_r > 0 means residency held; a cold pass pays
 *  the write and REports cache_r 0 (the next pass then reads). */
export async function warmOnce(o: {
	front: string;
	key: string;
	prefix: CapturedPrefix | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<WarmResult> {
	if (!o.prefix)
		return {
			verdict: "skipped",
			why: "no captured prefix — run: bun hooks/bin/prefix-keepwarm.ts --capture",
			ms: 0,
			usage: null,
		};
	const fetchImpl = o.fetchImpl ?? fetch;
	const t0 = Date.now();
	try {
		const r = await fetchImpl(`${o.front}/w/${PREFIX_SID}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				authorization: `Bearer ${o.key}`,
			},
			body: JSON.stringify(warmBody(o.prefix, Date.now())),
			signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
		});
		const doc = (await r.json().catch(() => null)) as {
			usage?: unknown;
		} | null;
		const ms = Date.now() - t0;
		if (!r.ok)
			return {
				verdict: "fail",
				why: `front HTTP ${r.status}`,
				ms,
				usage: doc ? usageFromAnthropic(doc.usage) : null,
			};
		return {
			verdict: "pass",
			why: "prefix replayed",
			ms,
			usage: doc ? usageFromAnthropic(doc.usage) : null,
		};
	} catch (e) {
		return {
			verdict: "fail",
			why: `front unreachable: ${String(e).slice(0, 120)}`,
			ms: Date.now() - t0,
			usage: null,
		};
	}
}

// ---- auth: the session-enrollment shape, fixed sid -------------------------

export type KeepwarmAuth =
	| { mode: "enrolled"; key: string; front: string }
	| { mode: "skipped"; why: string };

const probeFrontUp = async (
	front: string,
	fetchImpl: typeof fetch,
): Promise<boolean> => {
	try {
		const r = await fetchImpl(`${front}/status`, {
			signal: AbortSignal.timeout(600),
		});
		return r.ok;
	} catch {
		return false;
	}
};

/** Reuse-or-mint the keepwarm's scoped key (0600 meta+settings under the
 *  runtime home, TTL backstop like every enrollment). Skipped — never
 *  belt-direct: a keepwarm off the front would touch a different cache. */
export async function ensureKeepwarmAuth(
	o: {
		front?: string;
		fleetDir?: string;
		fetchImpl?: typeof fetch;
		admin?: string | null;
		govMode?: "strict" | "solo";
	} = {},
): Promise<KeepwarmAuth> {
	const front = o.front ?? BUCKLE_FRONT;
	const fetchImpl = o.fetchImpl ?? fetch;
	if (!(await probeFrontUp(front, fetchImpl)))
		return { mode: "skipped", why: `buckle front ${front} unreachable` };
	const admin = o.admin !== undefined ? o.admin : adminKey();
	if (!admin) return { mode: "skipped", why: "no BUCKLE_ADMIN_KEY (belt.env)" };
	const enrolled = await enrollSessionKey({
		fleet: o.fleetDir ?? runtimeHome(),
		sid: PREFIX_SID,
		front,
		frontUp: true,
		govMode: o.govMode ?? "solo",
		admin,
		fetchFn: fetchImpl,
	});
	if (enrolled.mode !== "enrolled")
		return { mode: "skipped", why: "buckle key mint failed" };
	return { mode: "enrolled", key: enrolled.key, front: enrolled.front };
}

// ---- capture: one-shot listener + capture client ---------------------------

export interface CaptureResult {
	captured: boolean;
	/** The client exited; a non-zero exit with a capture is still a capture. */
	exitCode: number | null;
	prefix: CapturedPrefix | null;
	forwarded: boolean;
}

/** Run the capture client against a one-shot loopback listener. The FIRST
 *  /v1/messages POST gives the stable prefix (saved before forwarding);
 *  every request is forwarded verbatim to the real front with the keepwarm
 *  key so the capture client still runs to completion. */
export async function capturePrefix(o: {
	front: string;
	key: string;
	outPath?: string;
	/** The capture client; default: a one-shot claude -p. */
	argv?: string[];
	timeoutMs?: number;
}): Promise<CaptureResult> {
	const upstream = `${o.front}/w/${PREFIX_SID}/v1/messages`;
	const outPath = o.outPath ?? prefixCachePath();
	let saved: CapturedPrefix | null = null;
	let forwarded = false;
	const forward = async (req: Request): Promise<Response> => {
		const raw = await req.text();
		try {
			const fr = await fetch(upstream, {
				method: "POST",
				headers: {
					"content-type": req.headers.get("content-type") ?? "application/json",
					"anthropic-version":
						req.headers.get("anthropic-version") ?? "2023-06-01",
					authorization: `Bearer ${o.key}`,
				},
				body: raw,
			});
			forwarded = true;
			return new Response(fr.body, {
				status: fr.status,
				headers: {
					"content-type": fr.headers.get("content-type") ?? "application/json",
				},
			});
		} catch {
			return Response.json(
				{ error: "prefix-capture: forward failed (prefix still saved)" },
				{ status: 502 },
			);
		}
	};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages"))
				return new Response("prefix-capture listener\n", { status: 404 });
			if (!saved) {
				const body: unknown = await req
					.clone()
					.json()
					.catch(() => null);
				const prefix = extractPrefix(body);
				if (prefix) {
					saved = prefix;
					savePrefix(prefix, outPath);
				}
			}
			return forward(req);
		},
	});
	// Settings-env clobber (W57 lesson): user settings.json env rides OVER the
	// spawn env, so the base-URL pin goes in a 0600 per-run settings file —
	// the dispatch lane-settings shape — not ANTHROPIC_BASE_URL alone.
	const settingsPath = `${outPath}.capture-settings.json`;
	writeFileSync(
		settingsPath,
		JSON.stringify({
			env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` },
		}),
		{ mode: 0o600 },
	);
	const argv = o.argv ?? [
		"claude",
		"-p",
		"prefix capture probe — reply with the single word: ok",
		"--max-turns",
		"1",
		"--settings",
		settingsPath,
	];
	try {
		const proc = Bun.spawn(argv, {
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
			},
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 180_000);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		return {
			captured: saved !== null,
			exitCode,
			prefix: saved,
			forwarded,
		};
	} finally {
		server.stop(true);
		rmSync(settingsPath, { force: true });
	}
}

// ---- report: the before/after measurement ----------------------------------

const ratio = (part: number, whole: number): number | null =>
	whole > 0 ? part / whole : null;
const pct = (r: number | null): string =>
	r === null ? "n/a" : `${(r * 100).toFixed(1)}%`;

/** Cache telemetry from the spoke ledger. Two views: per-lane dispatch
 *  briefs (route_audit: cached share of cached-token traffic) and per-model
 *  totals (router_usage: cache_r over ALL input). Read-only connection. */
export function reportCache(o: { dbPath: string; hours: number }): string {
	const db = new Database(o.dbPath, { readonly: true });
	try {
		const cutoff = new Date(Date.now() - o.hours * 3_600_000).toISOString();
		const lanes = db
			.query(
				"SELECT lane, COUNT(*) n, SUM(COALESCE(cache_r,0)) cr, SUM(COALESCE(cache_c,0)) cc FROM route_audit WHERE ts >= ? AND lane != '' GROUP BY lane ORDER BY n DESC",
			)
			.all(cutoff) as Array<{
			lane: string;
			n: number;
			cr: number;
			cc: number;
		}>;
		const bucket = `${new Date(Date.now() - o.hours * 3_600_000).toISOString().slice(0, 13)}:00`;
		const models = db
			.query(
				"SELECT model, SUM(in_tok) i, SUM(cache_r) cr, SUM(cache_c) cc, SUM(requests) reqs FROM router_usage WHERE hour_bucket >= ? GROUP BY model ORDER BY i DESC",
			)
			.all(bucket) as Array<{
			model: string;
			i: number;
			cr: number;
			cc: number;
			reqs: number;
		}>;
		const lines: string[] = [
			`prefix-cache report (last ${o.hours}h, ${o.dbPath})`,
		];
		for (const m of models) {
			lines.push(
				`  model ${m.model}: ${m.reqs} reqs, in_tok ${m.i}, cache_r ${m.cr}, cache_c ${m.cc} — read share ${pct(ratio(m.cr, m.i + m.cr + m.cc))}`,
			);
		}
		if (lanes.length === 0) lines.push("  lanes: (none in window)");
		for (const l of lanes.slice(0, 30)) {
			lines.push(
				`  lane ${l.lane}: ${l.n} reqs, cache_r ${l.cr}, cache_c ${l.cc}`,
			);
		}
		return lines.join("\n");
	} finally {
		db.close();
	}
}

// ---- CLI -------------------------------------------------------------------

const usage = (): void => {
	console.log(
		[
			"usage: bun hooks/bin/prefix-keepwarm.ts [--capture [-- <client argv…>]] [--report [hours]] [--prefix <path>]",
			"  default   one warm pass (replays the captured stable prefix)",
			"  --capture record the stable prefix from a real lane request (default client: claude -p, one turn)",
			"  --report  cache telemetry from the spoke ledger (default 48h)",
		].join("\n"),
	);
};

const main = async (): Promise<number> => {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) {
		usage();
		return 0;
	}
	const prefixPathIdx = argv.indexOf("--prefix");
	const prefixPath = prefixPathIdx >= 0 ? argv[prefixPathIdx + 1] : undefined;
	if (argv.includes("--report")) {
		const hoursIdx = argv.indexOf("--report");
		const hours = Number(argv[hoursIdx + 1]) || 48;
		console.log(
			reportCache({ dbPath: join(runtimeHome(), "buckle.db"), hours }),
		);
		return 0;
	}
	const auth = await ensureKeepwarmAuth();
	if (auth.mode === "skipped") {
		console.log(`prefix-keepwarm: skipped — ${auth.why}`);
		return 0;
	}
	if (argv.includes("--capture")) {
		const sep = argv.indexOf("--");
		const clientArgv = sep >= 0 ? argv.slice(sep + 1) : undefined;
		const cap = await capturePrefix({
			front: auth.front,
			key: auth.key,
			outPath: prefixPath,
			argv: clientArgv,
		});
		if (cap.prefix) {
			const sys = JSON.stringify(cap.prefix.system).length;
			console.log(
				`captured: model ${cap.prefix.model}, ${cap.prefix.tools.length} tools, system ~${sys} chars → ${prefixPath ?? prefixCachePath()}`,
			);
		} else {
			console.log("capture: NO prefix seen (client sent no /v1/messages)");
		}
		console.log(
			`client exit ${cap.exitCode ?? "n/a"}, forwarded: ${cap.forwarded}`,
		);
		return cap.captured ? 0 : 1;
	}
	const w = await warmOnce({
		front: auth.front,
		key: auth.key,
		prefix: loadPrefix(prefixPath),
	});
	const u = w.usage;
	console.log(
		`prefix-keepwarm ${new Date().toISOString()}  ${w.verdict} ${w.ms}ms  ${w.why}${u ? `  in ${u.in_tok} cache_r ${u.cache_r} cache_c ${u.cache_c} out ${u.out_tok}` : ""}`,
	);
	return w.verdict === "fail" ? 1 : 0;
};

await main();
