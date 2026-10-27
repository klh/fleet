// test/seed-group-run.test.ts — W1124.12.2: the bounded process-group seed
// runner. Covered: normal-run capture (code/out/err, NO termination claim),
// capped output under a chatty seed, and THE regression the mission demands —
// a real shell wrapper spawning a real /bin/sleep descendant whose PID the
// fixture CAPTURES to a file; the deadline fires, the whole group is
// cancelled, and the captured descendant is verified dead (kill -0 → ESRCH)
// within a bounded wall. A timeout return alone must never stand in for tree
// termination — the verdict is the verified group probe.
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStarter } from "../scripts/lib/lane-starter.ts";
import { runSeedGroup } from "../scripts/lib/seed-group-run.ts";

const scratch = (): string => {
	const d = join(
		tmpdir(),
		`w1124-12-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(d, { recursive: true });
	return d;
};

const pidAppears = async (pidFile: string): Promise<string> => {
	for (let i = 0; i < 100; i++) {
		try {
			return readFileSync(pidFile, "utf8").trim();
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	throw new Error(`descendant pid never appeared: ${pidFile}`);
};

const pidDead = (pid: string): boolean =>
	Bun.spawnSync(["/bin/kill", "-0", pid]).exitCode !== 0;

/** Real descendant fixture: a shell wrapper (the seed-executor shape) that
 *  spawns a REAL /bin/sleep (never a copied binary — copies die as fake
 *  zombies), captures the descendant PID, and blocks in wait. */
const descendantWrapper = (pidFile: string): string =>
	`#!/bin/sh
/bin/sleep 30 &
printf '%s\\n' "$!" > '${pidFile}'
wait
`;

describe("seed-group-run (W1124.12.2)", () => {
	test("normal exit: code/out/err captured, NO termination claim", async () => {
		const d = scratch();
		const r = await runSeedGroup(
			"/bin/sh",
			["-c", "echo out-1; echo err-1 1>&2; exit 7"],
			{ cwd: d, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000 },
		);
		expect(r.code).toBe(7);
		expect(r.out).toContain("out-1");
		expect(r.err).toContain("err-1");
		expect(r.timedOut).toBe(false);
		expect(r.verifiedDown).toBeNull();
		expect(r.survivors).toBe(false);
		expect(r.cancelSignal).toBeNull();
		rmSync(d, { recursive: true, force: true });
	});

	test("chatty seed output is capped (bounded memory, drain keeps flowing)", async () => {
		const d = scratch();
		const r = await runSeedGroup(
			"/bin/sh",
			[
				"-c",
				"i=0; while [ $i -lt 4000 ]; do echo 0123456789012345678901234567890123456789012345678901234567890123; i=$((i+1)); done",
			],
			{ cwd: d, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 },
		);
		expect(r.code).toBe(0);
		expect(r.out.length).toBeLessThanOrEqual(256 * 1024);
		rmSync(d, { recursive: true, force: true });
	}, 30_000);

	test("deadline cancellation kills the CAPTURED descendant (group proof)", async () => {
		const d = scratch();
		const pidFile = join(d, "descendant.pid");
		const wrapper = join(d, "wrapper.sh");
		writeFileSync(wrapper, descendantWrapper(pidFile));
		chmodSync(wrapper, 0o700);
		const t0 = Date.now();
		const r = await runSeedGroup(wrapper, [], {
			cwd: d,
			env: { PATH: "/usr/bin:/bin" },
			timeoutMs: 1_000,
			termGraceMs: 500,
			reapBudgetMs: 3_000,
		});
		const wall = Date.now() - t0;
		const descendant = await pidAppears(pidFile);
		expect(r.timedOut).toBe(true);
		expect(r.verifiedDown).toBe(true);
		expect(r.survivors).toBe(false);
		// sleep answers the group SIGTERM — the SIGKILL fallback never fires
		expect(r.cancelSignal).toBe("SIGTERM");
		expect(r.code).toBeNull();
		// bounded: deadline + grace + reap budget — never an unbounded hang
		expect(wall).toBeGreaterThanOrEqual(1_000);
		expect(wall).toBeLessThan(10_000);
		// THE proof: the captured descendant PID answers nothing (ESRCH)
		expect(pidDead(descendant)).toBe(true);
		rmSync(d, { recursive: true, force: true });
	}, 15_000);

	test("ensureStarter seed deadline: failure record carries the verified group truth", async () => {
		const fleet = scratch();
		const d = scratch();
		const pidFile = join(d, "descendant.pid");
		const wrapper = join(d, "wrapper.sh");
		writeFileSync(wrapper, descendantWrapper(pidFile));
		chmodSync(wrapper, 0o700);
		const r = await ensureStarter(
			fleet,
			"claude",
			wrapper,
			{
				PATH: "/usr/bin:/bin",
			},
			{ timeoutMs: 1_000 },
		);
		expect(r?.kind).toBe("failure");
		if (r?.kind !== "failure") return;
		expect(r.failure.timedOut).toBe(true);
		expect(r.failure.verifiedDown).toBe(true);
		expect(r.failure.survivors).toBe(false);
		const descendant = await pidAppears(pidFile);
		expect(pidDead(descendant)).toBe(true);
		rmSync(fleet, { recursive: true, force: true });
		rmSync(d, { recursive: true, force: true });
	}, 15_000);
});
