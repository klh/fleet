// test/w2588-socket-idle-guards.e2e.ts — W2588 regression: Bun's fetch
// carries an independent default 5-minute socket-idle timer (coarse) that
// aborts an open body IN BAND ('The operation timed out') while the
// explicit Fleet deadline guards (TTFB signal, W450 stream idle/total,
// caller abort) never fire — live shape: full-5.3 streams died ~330s in
// with timeoutPhase=null/cancellation=null. defaultFetch now passes
// timeout:false (W2588) so those guards stay the sole deadline
// authorities. This spec pins the corrected behavior on the real wire.
//
// Method (root #103756/#103762/#103767): the hidden timer is process-level,
// so the parent spawns the bun CHILD (w2588-socket-idle-child.ts) via the
// kit runCli under BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 (process-local, no
// policy edits). The child hosts the kit serveStub pausing loopback
// upstream (explicit 127.0.0.1 bind, one chunk, 9s pause, close) AND the
// REAL defaultFetch in one event loop, closing the stub in its finally,
// guarded by its own bounded watchdog (nonzero exit if wedged). It must
// complete both chunks INSIDE its explicit budgets (TTFB 5s, idle 60s,
// total 120s ≫ the 9s pause) with timeoutPhase=null. The pre-W2588 wire
// FAIL of this exact child (TimeoutError ~8s, timeoutPhase=null — guards
// never fired) is banked in the lane run logs, not embedded here.
import { expect, test } from "@playwright/test";
import { runCli } from "@klh/test-kit";

test.describe("@unit W2588 socket-idle timer vs explicit stream guards", () => {
	// pause must clear the env-1 hidden-timer floor (~8s, measured 8003/
	// 8004ms) and stay under serveStub's server idle cutoff (~12s) — 9s it is
	const PAUSE_MS = 9_000;

	/** Kit runCli child under the shrunk idle env (real exit status, full
	 *  captured stdout — no pipes masking bun's own exit code, per root
	 *  #103760). The child owns its stub and watchdog; returns its JSON leg. */
	function runGuardedLeg(): {
		code: number;
		leg: Record<string, unknown> | null;
	} {
		const child = new URL("./w2588-socket-idle-child.ts", import.meta.url)
			.pathname;
		const r = runCli(child, [], {
			env: {
				// the only runtime knob: the child's own socket idle floor;
				// no policy edits, no global env writes
				BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1",
			},
		});
		const line = r.out
			.trim()
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.pop();
		return {
			code: r.code,
			leg: line ? (JSON.parse(line) as Record<string, unknown>) : null,
		};
	}

	test("guarded wire survives a socket-idle pause within its explicit budgets", async () => {
		const { code, leg } = runGuardedLeg();
		expect(code, JSON.stringify(leg)).toBe(0); // clean child exit
		expect(leg, JSON.stringify(leg)).toBeTruthy();

		// the REAL guarded wire completes both chunks INSIDE its explicit
		// guard budgets (TTFB 5s, idle 60s, total 120s — all ≫ the 9s
		// pause) with no guard firing: timeout:false disabled only the
		// hidden socket timer. The old-wire FAIL of this exact child
		// (TimeoutError ~8s, timeoutPhase=null) is banked in run logs.
		expect(leg?.ok, JSON.stringify(leg)).toBe(true);
		expect(
			Number(leg?.elapsedMs ?? 0),
			JSON.stringify(leg),
		).toBeGreaterThanOrEqual(PAUSE_MS);
		expect(leg?.timeoutPhase, JSON.stringify(leg)).toBe(null);
	}, 60_000);
});
