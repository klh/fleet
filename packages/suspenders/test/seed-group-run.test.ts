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
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStarter, startersDir } from "../scripts/lib/lane-starter.ts";
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

/** W1175 fixture — the CAPTURED failure shape the W1124.12.2 review found:
 *  the wrapper (direct child) traps TERM and exits promptly, while its
 *  descendant sets TERM to SIG_IGN (an ignored disposition survives exec,
 *  so the exec'd sleep ignores it too). The group therefore survives the
 *  group SIGTERM and only the SIGKILL escalation ends it. */
const termIgnoringWrapper = (pidFile: string): string =>
	`#!/bin/sh
trap 'exit 0' TERM
sh -c 'trap "" TERM; exec /bin/sleep 30' &
printf '%s\\n' "$!" > '${pidFile}'
wait
`;

/** W1175 fixture: the same TERM-ignoring tree, but the seed ALSO printed a
 *  usable session id before wedging — the exact input the W1124.12.2
 *  ensureStarter wrongly banked as fork success. */
const survivorSeedWrapper = (pidFile: string): string =>
	`#!/bin/sh
printf '%s\\n' '{"session_id":"w1175-survivor-seed"}'
trap 'exit 0' TERM
sh -c 'trap "" TERM; exec /bin/sleep 30' &
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

	test("W1175: parent exits on TERM but the TERM-ignoring descendant forces group SIGKILL (captured survivor)", async () => {
		const d = scratch();
		const pidFile = join(d, "descendant.pid");
		const wrapper = join(d, "wrapper.sh");
		writeFileSync(wrapper, termIgnoringWrapper(pidFile));
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
		// THE W1124.12.2 gap: escalation keyed on direct-child exit skipped
		// the group KILL when the parent exited in grace — the group probe,
		// not child exit, now decides
		expect(r.cancelSignal).toBe("SIGKILL");
		expect(r.verifiedDown).toBe(true);
		expect(r.survivors).toBe(false);
		expect(r.code).toBeNull();
		// bounded: deadline + grace + reap budget — never an unbounded hang
		expect(wall).toBeGreaterThanOrEqual(1_000);
		expect(wall).toBeLessThan(10_000);
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

	test("W1175 fail-closed (stub): a timed-out seed with survivors never banks its session id", async () => {
		const fleet = scratch();
		const logs: string[] = [];
		const r = await ensureStarter(fleet, "claude", "/bin/true", {}, {
			run: async () => ({
				code: null,
				out: `${JSON.stringify({ session_id: "w1175-survivor-seed" })}\n`,
				err: "",
				timedOut: true,
				verifiedDown: false,
				survivors: true,
			}),
			log: (l) => logs.push(l),
		});
		expect(r?.kind).toBe("failure");
		if (r?.kind !== "failure") return;
		expect(r.failure.timedOut).toBe(true);
		expect(r.failure.verifiedDown).toBe(false);
		expect(r.failure.survivors).toBe(true);
		// the unsafe record was NEVER cached: the registry dir is not created
		// until a seed actually banks
		expect(existsSync(startersDir(fleet))).toBe(false);
		expect(logs.join(" ")).toMatch(/seed failed/);
		rmSync(fleet, { recursive: true, force: true });
	});

	test("W1175 fail-closed (review edge): survivors without timedOut still never banks", async () => {
		const fleet = scratch();
		const logs: string[] = [];
		const r = await ensureStarter(fleet, "claude", "/bin/true", {}, {
			// the public run seam allows omitted timedOut — an explicit
			// survivors/failed-verification verdict is unsafe on its own
			run: async () => ({
				code: 0,
				out: `${JSON.stringify({ session_id: "w1175-edge-seed" })}\n`,
				err: "",
				survivors: true,
				verifiedDown: false,
			}),
			log: (l) => logs.push(l),
		});
		expect(r?.kind).toBe("failure");
		if (r?.kind !== "failure") return;
		expect(r.failure.timedOut).toBe(false);
		expect(r.failure.survivors).toBe(true);
		expect(existsSync(startersDir(fleet))).toBe(false);
		// diagnostic truth: no "timed out" claim without the deadline flag
		expect(logs.join(" ")).not.toMatch(/timed out/);
		expect(logs.join(" ")).toMatch(/survivors possible \(verifiedDown=false\)/);
		rmSync(fleet, { recursive: true, force: true });
	});

	test("W1175 fail-closed (real survivor seed): session id printed, group escalated, nothing banked", async () => {
		const fleet = scratch();
		const d = scratch();
		const pidFile = join(d, "descendant.pid");
		const wrapper = join(d, "wrapper.sh");
		writeFileSync(wrapper, survivorSeedWrapper(pidFile));
		chmodSync(wrapper, 0o700);
		const r = await ensureStarter(
			fleet,
			"claude",
			wrapper,
			{ PATH: "/usr/bin:/bin" },
			{ timeoutMs: 1_000 },
		);
		expect(r?.kind).toBe("failure");
		if (r?.kind !== "failure") return;
		expect(r.failure.timedOut).toBe(true);
		// W1175 group escalation: the TERM-ignoring tree got the group KILL —
		// verified down, no survivors left behind
		expect(r.failure.verifiedDown).toBe(true);
		expect(r.failure.survivors).toBe(false);
		// the printed session id was never banked despite being present
		expect(existsSync(startersDir(fleet))).toBe(false);
		const descendant = await pidAppears(pidFile);
		expect(pidDead(descendant)).toBe(true);
		rmSync(fleet, { recursive: true, force: true });
		rmSync(d, { recursive: true, force: true });
	}, 20_000);

	test("W1175 (57715): unverified-only verdict never logs timed out or verified down", async () => {
		const fleet = scratch();
		const logs: string[] = [];
		const run = async () => ({
			code: 0,
			out: `${JSON.stringify({ session_id: "w1175-57715-seed" })}\n`,
			err: "",
			verifiedDown: false,
			survivors: false,
		});
		await ensureStarter(fleet, "claude", "/bin/true", {}, {
			run,
			log: (l) => logs.push(l),
		});
		expect(logs.join(" ")).toMatch(/unverified \(verifiedDown=false\)/);
		expect(logs.join(" ")).not.toMatch(/timed out|group verified down/);
		rmSync(fleet, { recursive: true, force: true });
	});
});
