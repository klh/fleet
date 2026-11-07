// test/fixture-kev-isolation.e2e.ts — W2573 co-situated proof: fixture CLI
// children never contact a live Kev advisory. The incident: cliFixture's
// scratch HOME does not de-network `coord capsule set` / `work done` —
// kevUrl() resolves :8912 by default (settings reader ignores empty env,
// falls back to the section default), so each advisory call awaited the
// full 8s curation timeout against the real box (two per test ≈ 16s of a
// 20s cap — the completion-native-transcript timeouts). The harness now
// pins SUSPENDERS_KEV_URL to an instantly-refused loopback port. Proven
// here end-to-end, riding the kit (scratchWorld/serveStub/runCliAsync —
// spawnSync would block this parent's loop and the stub could never
// answer, the coord-hubs trap).
import { runCliAsync, scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const KEV_ANSWER = () =>
	Response.json({
		model: "kev-latest",
		answers: {
			d: {
				type: "choice",
				choice: "noise",
				confidence: 0.9,
				probabilities: { noise: 0.9 },
			},
		},
		usage: { input_tokens: 5, output_tokens: 1 },
		latency_ms: 1,
	});

// A poisoning URL that must NEVER receive a request: unroutable, and any
// attempt would hang until timeout — a hit both fails the zero-contact
// assert and blows the test's own time budget.
const POISON = "http://192.0.2.1:8912";

test("fixture capsule set: poisoned ambient kev never contacted; default pin refuses instantly", async () => {
	const saved = process.env.SUSPENDERS_KEV_URL;
	process.env.SUSPENDERS_KEV_URL = POISON;
	const world = scratchWorld({ prefix: "w2573-kev-iso-" });
	try {
		// the world's pin survives ambient poisoning (scratchWorld spread
		// order: process.env first, pins last)
		expect(world.env.SUSPENDERS_KEV_URL).toBe("http://127.0.0.1:9");
		const began = Date.now();
		const r = await runCliAsync(
			join(BIN, "coord.ts"),
			[
				"capsule",
				"set",
				"--as",
				"w2573-probe",
				"--done",
				"isolation probe",
				"--next",
				"none",
			],
			{ cwd: world.repo, env: world.env },
		);
		const took = Date.now() - began;
		expect(r.code, r.err).toBe(0);
		// two advisory awaits (capsule curation) against port 9 refuse in
		// milliseconds — the 8s+ budget of a live-contact miss is the bug
		expect(took).toBeLessThan(5000);
		expect(r.out).toContain("capsule stored");
	} finally {
		if (saved === undefined) delete process.env.SUSPENDERS_KEV_URL;
		else process.env.SUSPENDERS_KEV_URL = saved;
		world.clean();
	}
});

test("fixture capsule set: injected stub kev answers and carries the curation verdict", async () => {
	const stub = serveStub(KEV_ANSWER);
	const world = scratchWorld({ prefix: "w2573-kev-stub-" });
	try {
		const env = { ...world.env, SUSPENDERS_KEV_URL: stub.url };
		const r = await runCliAsync(
			join(BIN, "coord.ts"),
			[
				"capsule",
				"set",
				"--as",
				"w2573-probe",
				"--done",
				"stub probe",
				"--next",
				"none",
			],
			{ cwd: world.repo, env },
		);
		expect(r.code, r.err).toBe(0);
		// the stub got the curation POST and the rendered verdict is the
		// stubbed choice — advisory wiring intact, just pointed at the kit
		expect(stub.requests.length).toBeGreaterThanOrEqual(1);
		expect(stub.requests[0]?.path).toBe("/v1/systemone");
		expect(r.out).toContain("Kev noise");
	} finally {
		stub.close();
		world.clean();
	}
});
