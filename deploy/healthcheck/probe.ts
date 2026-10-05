// deploy/healthcheck/probe.ts — the health sidecar (owner law 2026-10-05):
// a healthcheck is only valid when it does NOT run in the served process.
// Every hub service gets one of these as a sidecar container: it polls the
// real target over the network and serves the verdict — compose health hits
// the SIDECAR, never the server, so a wedged server runtime cannot paint
// itself healthy.
//   server: bun probe.ts --target http://127.0.0.1:4111/status --listen 4112 [--every 5000] [--timeout 2000]
//           GET /status → 200 {ok:true,...} when the target is healthy, 502 otherwise
//   cli:    bun probe.ts --target URL [--timeout 2000] — one-shot, exit 0/1

interface ProbeArgs {
	target: string;
	listen?: number;
	every?: number;
	timeout?: number;
}

function parseArgs(argv: string[]): ProbeArgs {
	const args: ProbeArgs = { target: "", timeout: 2000, every: 5000 };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const val = argv[i + 1];
		if (val === undefined) continue;
		if (flag === "--target") args.target = val;
		else if (flag === "--listen") args.listen = Number(val);
		else if (flag === "--every") args.every = Number(val);
		else if (flag === "--timeout") args.timeout = Number(val);
		i++;
	}
	return args;
}

interface Verdict {
	ok: boolean;
	status: number;
	ms: number;
	checkedAt: string;
}

async function probe(target: string, timeoutMs: number): Promise<Verdict> {
	const t0 = Date.now();
	try {
		const r = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
		return {
			ok: r.ok,
			status: r.status,
			ms: Date.now() - t0,
			checkedAt: new Date().toISOString(),
		};
	} catch {
		return {
			ok: false,
			status: 0,
			ms: Date.now() - t0,
			checkedAt: new Date().toISOString(),
		};
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.target.length === 0) {
		console.log(
			"usage: probe.ts --target URL [--listen port] [--every ms] [--timeout ms]",
		);
		process.exit(2);
	}
	// CLI mode: one shot, exit code carries the verdict.
	if (args.listen === undefined) {
		const v = await probe(args.target, args.timeout ?? 2000);
		console.log(JSON.stringify(v));
		process.exit(v.ok ? 0 : 1);
	}
	// Server mode: poll the target, serve the verdict — the sidecar never
	// trusts the target's process, only its wire answer.
	let last: Verdict = await probe(args.target, args.timeout ?? 2000);
	let ticking = true;
	const tick = async (): Promise<void> => {
		if (ticking) return;
		ticking = true;
		try {
			last = await probe(args.target, args.timeout ?? 2000);
		} finally {
			ticking = false;
		}
	};
	void tick();
	const timer = setInterval(() => {
		void tick();
	}, args.every ?? 5000);
	timer.unref?.();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: args.listen,
		fetch: () =>
			Response.json(
				{ target: args.target, ...last },
				{ status: last.ok ? 200 : 502 },
			),
	});
	console.log(
		`healthcheck: sidecar on http://127.0.0.1:${server.port}/status -> ${args.target}`,
	);
}

await main();
