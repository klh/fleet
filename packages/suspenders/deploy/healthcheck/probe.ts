// deploy/healthcheck/probe.ts — the health sidecar (owner law 2026-10-05):
// a healthcheck is only valid when it does NOT run in the served process.
// Every hub service gets one of these as a sidecar container: it polls the
// real target over the network and serves the verdict on its OWN port —
// compose health hits the SIDECAR, never the server, so a wedged server
// runtime cannot paint itself healthy.
//
// Verdict (the sidecar never trusts the target's process, only its wire
// answer):
//   up        last poll succeeded — healthy = last probe ok
//   degrading missLimit consecutive misses; an ACTIVE confirming re-probe
//           runs before the down flip (a single blip must not drop a
//           service — and a stale sample must never vouch for a live one)
//   down      the confirming re-probe also failed; stays down until any
//           poll succeeds again
//
// Config — CLI flag > env > default (config-over-code: hubctl render emits
// the profile knobs; the container env carries them in):
//   TARGET_URL   URL to poll (--target)
//   PORT         the sidecar's own serve port (--listen)
//   PROBE_PATH   optional path replacing the target URL's path (--path;
//                deliberately NOT the env name PATH — that is the
//                executable search path)
//   INTERVAL     poll interval ms (--every, default 5000)
//   TIMEOUT_MS   per-probe timeout ms (--timeout, default 2000)
//   MISS_LIMIT   consecutive misses before the confirming re-probe
//                (--misses, default 3)
//   RING         bounded ring of recent results (--ring, default 20)
//
//   server: bun probe.ts --target http://127.0.0.1:4111/status --listen 4112
//           GET /healthz → 200 when up, 502 once degraded/down (compose
//           health hits this) · GET /status → full JSON verdict
//   cli:    bun probe.ts --target URL [--timeout 2000] — one-shot, exit 0/1

export interface ProbeArgs {
	target: string;
	listen?: number;
	path?: string;
	every: number;
	timeout: number;
	misses: number;
	ring: number;
}

interface Sample {
	ok: boolean;
	status: number;
	ms: number;
	at: string;
}

type VerdictState = "up" | "degrading" | "down";

interface FlagOverrides {
	target?: string;
	listen?: number;
	path?: string;
	every?: number;
	timeout?: number;
	misses?: number;
	ring?: number;
}

function optNum(v: string | undefined): number | undefined {
	if (v === undefined || v.trim().length === 0) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** Typed flag parse — last occurrence wins; unknown flags are ignored so a
 *  compose template can carry extra knobs without breaking the probe. */
function parseFlags(argv: string[]): FlagOverrides {
	const flags: FlagOverrides = {};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const val = argv[i + 1];
		if (val === undefined) continue;
		switch (flag) {
			case "--target":
				flags.target = val;
				break;
			case "--listen":
				flags.listen = optNum(val);
				break;
			case "--path":
				flags.path = val;
				break;
			case "--every":
				flags.every = optNum(val);
				break;
			case "--timeout":
				flags.timeout = optNum(val);
				break;
			case "--misses":
				flags.misses = optNum(val);
				break;
			case "--ring":
				flags.ring = optNum(val);
				break;
			default:
				continue;
		}
		i++;
	}
	return flags;
}

/** CLI flag > env > default — the compose env carries what the profile
 *  rendered; flags remain the explicit override. */
function resolveArgs(argv: string[]): ProbeArgs {
	const env = process.env;
	const f = parseFlags(argv);
	return {
		target: f.target ?? env.TARGET_URL ?? "",
		listen: f.listen ?? optNum(env.PORT),
		path: f.path ?? env.PROBE_PATH,
		every: f.every ?? optNum(env.INTERVAL) ?? 5000,
		timeout: f.timeout ?? optNum(env.TIMEOUT_MS) ?? 2000,
		misses: f.misses ?? optNum(env.MISS_LIMIT) ?? 3,
		ring: f.ring ?? optNum(env.RING) ?? 20,
	};
}

/** The poll URL: TARGET_URL/--target, with --path/PROBE_PATH replacing the
 *  URL's path when given. */
function targetUrl(args: ProbeArgs): string {
	const url = new URL(args.target);
	if (args.path !== undefined) url.pathname = args.path;
	return url.toString();
}

export async function probeOnce(
	url: string,
	timeoutMs: number,
): Promise<Sample> {
	const t0 = Date.now();
	try {
		const r = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		let ok = r.ok;
		if (ok && r.headers.get("content-type")?.includes("json")) {
			const reader = r.body?.getReader();
			let size = 0;
			const chunks: Uint8Array[] = [];
			if (reader) {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > 65536) throw new Error("probe response exceeds 64 KiB");
						chunks.push(value);
					}
				} finally {
					await reader.cancel();
				}
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			ok =
				body !== null &&
				typeof body === "object" &&
				!Array.isArray(body) &&
				body.ok !== false &&
				body.healthy !== false &&
				![
					"down",
					"unhealthy",
					"error",
					"failed",
					"unavailable",
					"dead",
					"stopped",
					"degraded",
				].includes(body.status);
		} else {
			await r.body?.cancel();
		}
		return {
			ok,
			status: r.status,
			ms: Date.now() - t0,
			at: new Date().toISOString(),
		};
	} catch {
		return {
			ok: false,
			status: 0,
			ms: Date.now() - t0,
			at: new Date().toISOString(),
		};
	}
}

/** The monitor: bounded result ring + the gated verdict. One probe on the
 *  wire at a time; the down flip requires an active confirming re-probe. */
export function createMonitor(args: ProbeArgs) {
	const url = targetUrl(args);
	const ring: Sample[] = [];
	let state: VerdictState = "down";
	let misses = 0;
	let lastOk: string | null = null;
	let total = 0;
	let okTotal = 0;
	let inFlight = false;

	function apply(s: Sample): void {
		ring.push(s);
		if (ring.length > args.ring) ring.shift();
		total++;
		if (s.ok) {
			okTotal++;
			misses = 0;
			state = "up";
			lastOk = s.at;
			return;
		}
		misses++;
	}

	async function poll(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const s = await probeOnce(url, args.timeout);
			apply(s);
			// degrading: past the miss limit and not yet down — actively
			// re-probe; the flip to down is earned only when the confirming
			// probe fails on the wire too. While degrading, every failed
			// poll re-confirms; any success anywhere recovers to up.
			if (!s.ok && misses >= args.misses && state !== "down") {
				state = "degrading";
				const confirm = await probeOnce(url, args.timeout);
				apply(confirm);
				if (!confirm.ok) state = "down";
			}
		} finally {
			inFlight = false;
		}
	}

	function snapshot(): {
		target: string;
		state: VerdictState;
		ok: boolean;
		misses: number;
		missLimit: number;
		lastOk: string | null;
		latencyMs: number | null;
		checkedAt: string | null;
		probes: { total: number; ok: number; failed: number };
		recent: Sample[];
	} {
		const last = ring.at(-1);
		const fresh =
			!!last &&
			Date.now() - Date.parse(last.at) <= args.every + args.timeout * 2;
		const reportedState = !fresh
			? "down"
			: !last?.ok && state === "up"
				? "degrading"
				: state;
		return {
			target: url,
			state: reportedState,
			ok: reportedState === "up" && last?.ok === true,
			misses,
			missLimit: args.misses,
			lastOk,
			latencyMs: last?.ms ?? null,
			checkedAt: last?.at ?? null,
			probes: { total, ok: okTotal, failed: total - okTotal },
			recent: [...ring],
		};
	}

	return { poll, snapshot };
}

async function main(): Promise<void> {
	const args = resolveArgs(process.argv.slice(2));
	if (args.target.length === 0) {
		console.log(
			"usage: probe.ts --target URL [--listen port] [--path p] [--every ms] [--timeout ms] [--misses n] [--ring n] (env: TARGET_URL PORT PROBE_PATH INTERVAL TIMEOUT_MS MISS_LIMIT RING)",
		);
		process.exit(2);
	}
	// CLI mode: one shot, exit code carries the verdict.
	if (args.listen === undefined) {
		const v = await probeOnce(targetUrl(args), args.timeout);
		console.log(JSON.stringify(v));
		process.exit(v.ok ? 0 : 1);
	}
	const monitor = createMonitor(args);
	// probe once BEFORE serving: the sidecar never vouches from ignorance
	await monitor.poll();
	const timer = setInterval(() => {
		void monitor.poll();
	}, args.every);
	timer.unref?.();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: args.listen,
		fetch: (req) => {
			const { pathname } = new URL(req.url);
			if (pathname !== "/healthz" && pathname !== "/status")
				return new Response("not found", { status: 404 });
			const headers = {
				allow: "GET, HEAD, OPTIONS",
				"cache-control": "no-store",
			};
			if (req.method === "OPTIONS")
				return new Response(null, { status: 204, headers });
			if (req.method !== "GET" && req.method !== "HEAD")
				return new Response("method not allowed", { status: 405, headers });
			const snap = monitor.snapshot();
			if (req.method === "HEAD")
				return new Response(null, { status: snap.ok ? 200 : 502, headers });
			if (pathname === "/healthz") {
				return Response.json(
					{ ok: snap.ok, state: snap.state, target: snap.target },
					{ status: snap.ok ? 200 : 502, headers },
				);
			}
			return Response.json(snap, { status: snap.ok ? 200 : 502, headers });
		},
	});
	console.log(
		`healthcheck: sidecar on http://127.0.0.1:${server.port}/healthz -> ${monitor.snapshot().target}`,
	);
}

if (import.meta.main) await main();
