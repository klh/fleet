// test/w2588-socket-idle-child.ts — the W2588 spec's child process: the
// kit serveStub pausing upstream AND the real defaultFetch in ONE process
// under BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 (set by the parent via kit runCli).
// One JSON line on stdout; exit 0 iff the guarded leg completed inside its
// explicit budgets (nonzero on failure or its own bounded watchdog). Not a
// spec itself — spawned by w2588-socket-idle-guards.e2e.ts. The pre-W2588
// FAIL of this exact child (old wire, same env/upstream/guards:
// TimeoutError at ~8s, timeoutPhase=null) is banked in the run logs and
// the item summary — the committed regression carries the corrected wire.
import { serveStub } from "@klh/test-kit";
import { defaultFetch } from "../src/wire.ts";
import type { UpstreamRequest } from "../src/router-types.ts";
import { TransportObservation } from "@klh/telemetry/src/transport-evidence.ts";

// pause above the env-1 hidden-timer floor (~8s, measured 8003/8004ms)
// and under serveStub's server idle cutoff (~12s)
const PAUSE_MS = 9_000;
// the child's own watchdog: a wedged leg exits nonzero, never hangs
const WATCHDOG_MS = 45_000;
// explicit guard budgets for the leg (all ≫ the pause)
const TTFB_MS = 5_000; // upstream answers headers immediately
const GUARDS = { idleMs: 60_000, totalMs: 120_000 } as const; // ≫ the pause

let completed = false;
const leg = (value: Record<string, unknown>) => {
	console.log(JSON.stringify({ leg: "guarded", ...value }));
	completed = value.ok === true;
};

// the child's own watchdog (root #103768): a wedged leg exits nonzero
// after the stub is closed — the parent's runCli is sync and bounded only
// by the test timeout, so the child must never hang past this timer
const watchdog = setTimeout(() => {
	up.close();
	leg({ ok: false, watchdog: true });
	process.exit(3);
}, WATCHDOG_MS);

// pausing upstream and guarded wire share this process (root #103767):
// one event loop, the child owns the stub lifecycle in its finally
const up = serveStub(() => {
	const stream = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("data: first\n\n"));
			setTimeout(() => {
				try {
					c.enqueue(new TextEncoder().encode("data: last\n\n"));
					c.close();
				} catch {
					// reader went away — dead-writer noise
				}
			}, PAUSE_MS);
		},
		cancel: () => {},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
});

// guarded: the REAL wire under explicit idle/total guards well above the
// pause — timeout:false (in defaultFetch) must own the hidden timer
const t0 = Date.now();
const transport = new TransportObservation();
try {
	const req: UpstreamRequest = {
		group: "w2588",
		dialect: "openai",
		path: "/v1/chat/completions",
		body: { model: "w2588", messages: [], stream: true },
		key: "",
		transport,
	} as UpstreamRequest;
	const resp = await defaultFetch(
		{ group: "w2588", url: up.url, dialect: "openai" },
		req,
		TTFB_MS,
		GUARDS,
		1_000,
	);
	const body = await resp.text();
	leg({
		ok: body.includes("first") && body.includes("last"),
		elapsedMs: Date.now() - t0,
		timeoutPhase: transport.snapshot()?.timeoutPhase ?? null,
	});
} catch (error) {
	leg({
		ok: false,
		elapsedMs: Date.now() - t0,
		errorName: (error as Error).name,
		errorText: String((error as Error).message),
		timeoutPhase: transport.snapshot()?.timeoutPhase ?? null,
	});
} finally {
	clearTimeout(watchdog);
	up.close(); // the child owns the stub lifecycle on every path
	// exit 0 iff the guarded leg completed (root #103756: assert child exit)
	process.exit(completed ? 0 : 1);
}
