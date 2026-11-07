// W2545: transient transport-terminal recovery in the managed Claude
// runtime. Hermetic: isolated HOME, GOVERNOR_STORE_URL=local, a controlled
// fake native executable — never a guessed protocol, never a live store.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signalClaudeDirectEvent } from "../hooks/lib/executors/claude-wake.ts";
import {
	bankTransientAbandonment,
	classifyTransientResult,
	parseTransientKnobs,
	transientBackoffMs,
} from "../hooks/lib/executors/claude-transient.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

const fixture = join(import.meta.dir, "fixtures/claude-stream-transient.ts");
const runtimeBin = join(import.meta.dir, "../hooks/bin/claude-runtime.ts");

type Spawn = {
	child: Bun.Process;
	frames: Record<string, unknown>[];
	read: Promise<void>;
	signal: (id: number, kind: string, payload?: unknown) => boolean;
};

function spawnRuntime(
	sid: string,
	home: string,
	env: Record<string, string>,
	killsAfterMs = 8000,
): Spawn {
	chmodSync(fixture, 0o700);
	// Hermetic by default: isolated HOME + local store; the live lane env's
	// GOVERNOR_STORE_URL/claim token never leak into a test runtime.
	const child = Bun.spawn([process.execPath, runtimeBin, "-p", "original"], {
		env: {
			...process.env,
			GOVERNOR_STORE_URL: "local",
			HOME: home,
			SUSPENDERS_SID: sid,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), killsAfterMs);
	const frames: Record<string, unknown>[] = [];
	const signal = (id: number, kind: string, payload?: unknown) =>
		signalClaudeDirectEvent(
			{
				id,
				target: sid,
				source: "coordinator",
				kind,
				payload: JSON.stringify(payload ?? { reason: "fixture" }),
			},
			sid,
			home,
		);
	const read = (async () => {
		let pending = "";
		for await (const chunk of child.stdout) {
			pending += new TextDecoder().decode(chunk);
			let i = pending.indexOf("\n");
			while (i >= 0) {
				const line = pending.slice(0, i);
				pending = pending.slice(i + 1);
				i = pending.indexOf("\n");
				try {
					frames.push(JSON.parse(line));
				} catch {}
			}
		}
	})();
	void timer;
	return { child, frames, read, signal };
}

const fastKnobs = {
	SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "10",
	SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "50",
	SUSPENDERS_CLAUDE_TRANSIENT_MAX_ATTEMPTS: "3",
};

/** Resolve once the runtime emitted `count` transient waiting frames — the
 * frame array fills asynchronously off the runtime's stdout, so assertions
 * arm before the frames exist. */
function waitForTransientWaiting(
	frames: Record<string, unknown>[],
	count = 1,
): Promise<void> {
	return new Promise((resolve) => {
		const t = setInterval(() => {
			if (
				frames.filter(
					(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
				).length >= count
			) {
				clearInterval(t);
				resolve();
			}
		}, 20);
	});
}

test.describe("classifier", () => {
	test("503 with subtype success and is_error is transient — evidence shape W2267.3", () => {
		const verdict = classifyTransientResult({
			type: "result",
			subtype: "success",
			is_error: true,
			api_error_status: 503,
			result: "API Error (503): upstream admission refused",
		});
		expect(verdict?.status).toBe(503);
	});
	test("429 with Retry-After carries the server-directed cooldown", () => {
		const verdict = classifyTransientResult({
			type: "result",
			is_error: true,
			api_error_status: 429,
			retry_after: 2,
		});
		expect(verdict?.status).toBe(429);
		expect(verdict?.retryAfterMs).toBe(2000);
	});
	test("nonretryable 400/401/quota/auth are NEVER transient", () => {
		for (const frame of [
			{ type: "result", is_error: true, api_error_status: 400 },
			{ type: "result", is_error: true, api_error_status: 401 },
			{ type: "result", is_error: true, api_error_status: 403 },
			{
				type: "result",
				is_error: true,
				api_error_status: 429,
				result: "quota exceeded for this plan",
			},
			{
				type: "result",
				is_error: true,
				result: "invalid api key",
			},
			{
				type: "result",
				is_error: true,
				api_error_status: 500,
				result: "billing insufficient credits",
			},
		])
			expect(classifyTransientResult(frame)).toBeNull();
	});
	test("error-free completion and non-result frames finish normally", () => {
		expect(
			classifyTransientResult({ type: "result", subtype: "success" }),
		).toBeNull();
		expect(
			classifyTransientResult({
				type: "result",
				subtype: "success",
				is_error: false,
			}),
		).toBeNull();
		expect(classifyTransientResult({ type: "assistant" })).toBeNull();
	});
	test("status only in message text is still classified (W2267.3 shape)", () => {
		const verdict = classifyTransientResult({
			type: "result",
			subtype: "success",
			is_error: true,
			result: "API Error (503): service overloaded",
		});
		expect(verdict?.status).toBe(503);
	});
	test("backoff is bounded, jittered, and honors capped Retry-After", () => {
		const knobs = parseTransientKnobs({
			SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "10",
			SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "100",
			SUSPENDERS_CLAUDE_TRANSIENT_MAX_ATTEMPTS: "3",
		});
		expect(knobs.maxAttempts).toBe(3);
		expect(
			transientBackoffMs(9, knobs, undefined, () => 0.5),
		).toBeLessThanOrEqual(100);
		// server-directed cooldown replaces the computed delay, still capped
		expect(transientBackoffMs(1, knobs, 10_000)).toBe(100);
	});
});

test("successful normal completion is untouched", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-ok-"));
	const sid = "transient-normal-complete";
	try {
		const spawn = spawnRuntime(sid, home, {
			...fastKnobs,
			SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
		});
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).toBe(0);
		const results = spawn.frames.filter((f) => f.type === "result");
		expect(results.at(-1)?.result).toBe("ORIGINAL_COMPLETE");
		expect(
			spawn.frames.some(
				(f) =>
					f.type === "fleet.claude.transient" &&
					(f.state === "waiting" || f.state === "abandoned"),
			),
		).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("repeated 503 then recovery: same native conversation, no duplicated work", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-retry-"));
	const sid = "transient-retry-recover";
	try {
		const spawn = spawnRuntime(sid, home, {
			...fastKnobs,
			SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503,429",
		});
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).toBe(0);
		const waiting = spawn.frames.filter(
			(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
		);
		expect(waiting).toHaveLength(2);
		expect(waiting[0]?.status).toBe(503);
		expect(waiting[1]?.status).toBe(429);
		// the continuation prompt is injected into the SAME native process
		const initPid = spawn.frames.find((f) => f.subtype === "init")?.pid;
		for (const f of spawn.frames)
			if (f.type === "result" && f.session_id) expect(f.pid).toBe(initPid);
		// recovery: the final result is the recovered completion, one native
		const finalResult = spawn.frames.filter((f) => f.type === "result").at(-1);
		expect(finalResult?.result).toBe("RECOVERED_COMPLETE");
		expect(spawn.frames.filter((f) => f.subtype === "init")).toHaveLength(1);
		// no tool replay: exactly one original + one retry per episode
		expect(spawn.frames.filter((f) => f.type === "result")).toHaveLength(3);
		const sessionIds = new Set(
			spawn.frames
				.filter((f) => f.type === "result" && f.session_id)
				.map((f) => f.session_id),
		);
		expect(sessionIds.size).toBe(1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("budget exhaustion persists a resumable disposition and exits EX_TEMPFAIL", async () => {
	const { home, cwd, sid, env: fixtureEnv } = pausedLaneFixture();
	try {
		const spawn = spawnRuntime(sid, home, {
			...fixtureEnv,
			...fastKnobs,
			SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			// every retry fails 503 forever: 3 attempts then abandonment
			SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503,503,503,503",
		});
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).toBe(75);
		const waiting = spawn.frames.filter(
			(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
		);
		expect(waiting).toHaveLength(3);
		const abandoned = spawn.frames.find(
			(f) => f.type === "fleet.claude.transient" && f.state === "abandoned",
		);
		expect(abandoned).toBeDefined();
		expect(abandoned?.capsule).toBe("written");
		expect(abandoned?.checkpoint).toMatch(/^[a-f0-9]{40}$/);
		// the capsule the runtime banked carries the transport cause
		const coordCli = join(import.meta.dir, "../hooks/bin/coord.ts");
		const p = Bun.spawnSync(
			[process.execPath, coordCli, "capsule", "get", "--as", sid],
			{
				cwd,
				env: { ...fixtureEnv, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const capsule = JSON.parse(p.stdout.toString()) as { done?: string };
		expect(capsule.done).toContain("transport-blocked after 4 attempt(s)");
		expect(capsule.done).toContain("status 503");
		// truthful state: no normal-close masquerade, no fake recovery
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("child exit during an episode never masquerades as success", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-childexit-"));
	const sid = "transient-child-exit";
	try {
		const spawn = spawnRuntime(sid, home, {
			...fastKnobs,
			SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503,503,503,503",
			SUSPENDERS_FIXTURE_TRANSIENT_CHILD_EXIT: "1",
		});
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).not.toBe(0);
		expect(
			spawn.frames.some(
				(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
			),
		).toBe(true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a wake note delivered mid-backoff never cancels the pending episode", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-note-"));
	const sid = "transient-note-interleave";
	try {
		// long window so the note genuinely lands mid-backoff (a 10ms
		// window lets the retry win the race and hides the regression)
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fastKnobs,
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "1500",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "1500",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				// one 503, then recovery on the retry turn
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
			},
			12000,
		);
		// urgent note lands DURING the backoff window
		const waiting = new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (
					spawn.frames.some(
						(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
					)
				) {
					clearInterval(t);
					resolve();
				}
			}, 20);
		});
		await waiting;
		expect(spawn.signal(20, "NOTE", { urgent: "1" })).toBe(true);
		const code = await spawn.child.exited;
		await spawn.read;
		// the note turn delivered AND the episode still recovered
		expect(spawn.frames.some((f) => f.result === "DIRECT_DELIVERED")).toBe(
			true,
		);
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			true,
		);
		expect(code).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("B1: a note in backoff window 2 never closes the runtime mid-episode", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-marker-"));
	const sid = "transient-marker-race";
	try {
		// 503, retry-turn 503 (window 2 arms), then recovery on retry 2; both
		// windows are long enough for an urgent note to genuinely interleave
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fastKnobs,
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "1500",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "1500",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503,503",
			},
			15000,
		);
		// window 1 fires the retry, which hits the second 503 and arms window 2
		await waitForTransientWaiting(spawn.frames, 2);
		// urgent note lands INSIDE window 2: its non-transient result must not
		// close the runtime while the armed retry still owns the episode
		expect(spawn.signal(21, "NOTE", { urgent: "1" })).toBe(true);
		const code = await spawn.child.exited;
		await spawn.read;
		expect(spawn.frames.some((f) => f.result === "DIRECT_DELIVERED")).toBe(
			true,
		);
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			true,
		);
		expect(code).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("pause during backoff fences the retry; resume re-arms and recovers", async () => {
	const { home, cwd, sid, env: fixtureEnv } = pausedLaneFixture();
	try {
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fixtureEnv,
				...fastKnobs,
				// long base so the pause lands mid-backoff, twice
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "3000",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "3000",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_ATTEMPTS: "3",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
			},
			25000,
		);
		try {
			// wait for the waiting frame, then request a canonical pause
			const waitingFor = (predicate: (f: Record<string, unknown>) => boolean) =>
				new Promise<void>((resolve) => {
					const t = setInterval(() => {
						if (spawn.frames.some(predicate)) {
							clearInterval(t);
							resolve();
						}
					}, 20);
				});
			await waitingFor(
				(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
			);
			const coord = join(import.meta.dir, "../hooks/bin/coord.ts");
			const call = (args: string[]) => {
				const p = Bun.spawnSync(
					[process.execPath, coord, ...args, "--as", sid],
					{
						cwd,
						env: { ...fixtureEnv, HOME: home },
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				return { code: p.exitCode, out: p.stdout.toString() };
			};
			expect(
				call(["fact", "set", `lane.${sid}.state`, "PAUSE_REQUESTED"]).code,
			).toBe(0);
			expect(spawn.signal(10, "pause_requested")).toBe(true);
			await waitingFor(
				(f) => f.type === "fleet.claude.pause" && f.state === "paused",
			);
			// the retry NEVER fired while paused: no retry turn reached the
			// native between the waiting frame and the canonical pause
			expect(spawn.frames.some((f) => f.result === "DIRECT_DELIVERED")).toBe(
				false,
			);
			const checkpoint = spawn.frames.find(
				(f) => f.type === "fleet.claude.pause" && f.state === "paused",
			)?.checkpoint;
			expect(checkpoint).toMatch(/^[a-f0-9]{40}$/);
			expect(call(["resume", sid, "--onto", String(checkpoint)]).code).toBe(0);
			expect(spawn.signal(11, "resume_ready")).toBe(true);
			// resume re-arms the episode; the fixture recovers on the retry
			const code = await spawn.child.exited;
			await spawn.read;
			expect(code).toBe(0);
			expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
				true,
			);
			expect(
				spawn.frames.some(
					(f) => f.type === "fleet.claude.pause" && f.state === "resumed",
				),
			).toBe(true);
		} finally {
			if (spawn.child.exitCode === null) spawn.child.kill();
			await spawn.child.exited;
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("stop during backoff (SIGTERM with the retry timer armed) exits promptly and preserved", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-sigterm-"));
	const sid = "transient-sigterm-backoff";
	try {
		// long backoff so SIGTERM genuinely lands with the timer armed
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fastKnobs,
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "5000",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "5000",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
			},
			20000,
		);
		await waitForTransientWaiting(spawn.frames, 1);
		const t0 = Date.now();
		spawn.child.kill("SIGTERM");
		const code = await spawn.child.exited;
		await spawn.read;
		// prompt stop (bounded well under the armed 5s window) with a
		// non-zero exit — never a masquerading success
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(code).not.toBe(0);
		// no retry fired, no recovery claimed
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("duplicate wake signal during an episode delivers exactly once (wake-once)", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-dupwake-"));
	const sid = "transient-duplicate-wake";
	try {
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fastKnobs,
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "1500",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "1500",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
			},
			15000,
		);
		await waitForTransientWaiting(spawn.frames, 1);
		const deliveredEvents = () =>
			spawn.frames
				.filter(
					(f) => f.type === "fleet.claude.delivery" && f.state === "delivered",
				)
				.map((f) => String(f.event));
		// wake 30 delivers inside the backoff window; only after its proof
		// may a further signal land (the pending slot is one deep)
		expect(spawn.signal(30, "NOTE", { urgent: "1" })).toBe(true);
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (deliveredEvents().includes("30")) {
					clearInterval(t);
					resolve();
				}
			}, 20);
		});
		// duplicate wake: re-signaling the SAME event id is refused at the
		// queue (id <= prev) — a proven delivery can never replay
		expect(spawn.signal(30, "NOTE", { urgent: "1" })).toBe(false);
		expect(deliveredEvents()).toEqual(["30"]);
		// a genuinely new id delivers normally, exactly once
		expect(spawn.signal(31, "NOTE", { urgent: "1" })).toBe(true);
		const code = await spawn.child.exited;
		await spawn.read;
		expect(deliveredEvents()).toEqual(["30", "31"]);
		// the runtime still recovered through its own retry turn
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			true,
		);
		expect(code).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("claim/worktree identity is preserved across a transient episode", async () => {
	const { home, cwd, sid, env: fixtureEnv, id, sha } = pausedLaneFixture();
	try {
		const spawn = spawnRuntime(sid, home, {
			...fixtureEnv,
			...fastKnobs,
			SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
		});
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).toBe(0);
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			true,
		);
		// the work graph still holds the claim untouched: same item, same
		// owner sid, same CLAIMED state — the episode never released it
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../hooks/bin/work.ts"),
				"show",
				id,
				"--json",
			],
			{
				cwd,
				env: { ...fixtureEnv, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const item = JSON.parse(p.stdout.toString()) as {
			state?: string;
			owner_sid?: string;
		};
		expect(item.state).toBe("CLAIMED");
		expect(item.owner_sid).toBe(sid);
		// worktree HEAD unmoved by the episode (baseline immutable)
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(head.stdout.toString().trim()).toBe(sha);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("runtime retryAfterMs path: server-directed cooldown replaces the backoff", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-transient-retryafter-"));
	const sid = "transient-retry-after";
	try {
		const spawn = spawnRuntime(
			sid,
			home,
			{
				...fastKnobs,
				// computed backoff would be 10-50ms; Retry-After 1s wins
				SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS: "10",
				SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS: "5000",
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
				SUSPENDERS_FIXTURE_TRANSIENT_EPISODE: "503",
				SUSPENDERS_FIXTURE_TRANSIENT_RETRY_AFTER: "1",
			},
			15000,
		);
		const code = await spawn.child.exited;
		await spawn.read;
		expect(code).toBe(0);
		const waiting = spawn.frames.find(
			(f) => f.type === "fleet.claude.transient" && f.state === "waiting",
		);
		// the armed window honored the server cooldown: >= 1000ms, capped
		// well under maxMs, and the episode recovered on that retry turn
		expect(waiting?.retryAfterMs).toBe(1000);
		expect(waiting?.delayMs).toBe(1000);
		expect(spawn.frames.some((f) => f.result === "RECOVERED_COMPLETE")).toBe(
			true,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("N3: a hung coord-capsule child is bounded — the receipt degrades, never blocks", async () => {
	const { home, cwd, sid, env } = pausedLaneFixture();
	try {
		// a fake coord CLI that never exits: without the bound the call
		// would hang the runtime's exit path past any SIGTERM window
		const hung = join(home, "hung-coord.ts");
		writeFileSync(hung, "await new Promise(() => {});\n");
		const t0 = Date.now();
		const receipt = await bankTransientAbandonment(
			sid,
			"api_error status 503: fixture",
			2,
			{ cwd, env: { ...env, HOME: home }, timeoutMs: 500 },
			hung,
		);
		// bounded well under an unbounded hang, receipt truthful
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(receipt.capsule).toBe("unavailable");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("bankTransientAbandonment writes the capsule through the coord CLI", async () => {
	const { home, cwd, sid, env } = pausedLaneFixture();
	try {
		const coordCli = join(import.meta.dir, "../hooks/bin/coord.ts");
		const receipt = await bankTransientAbandonment(
			sid,
			"api_error status 503: fixture",
			3,
			{ cwd, env: { ...env, HOME: home } },
			coordCli,
		);
		expect(receipt.checkpoint).toMatch(/^[a-f0-9]{40}$/);
		expect(receipt.capsule).toBe("written");
		const p = Bun.spawnSync(
			[process.execPath, coordCli, "capsule", "get", "--as", sid],
			{ cwd, env: { ...env, HOME: home }, stdout: "pipe", stderr: "pipe" },
		);
		const capsule = JSON.parse(p.stdout.toString()) as {
			done?: string;
			next?: string;
		};
		expect(capsule.done).toContain("transport-blocked after 3 attempt(s)");
		expect(capsule.done).toContain("status 503");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
