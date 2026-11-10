// test/post-merge-activation.e2e.ts — W2546 hermetic regression: the
// truthful post-merge activation. Every owner escalation is a falsifiable
// case against REAL seams on isolated fixtures (temp HOME, no live
// launchd, no machine config): the runner contract (post-merge-runner),
// the decision core (runtime-sync), the carry (post-merge-carry over real
// plutil-parsed plist units), and the fleet-loop same-head re-entry. No
// mock ever returns "carried" unconditionally — every carry outcome is
// forced by fixture state.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { resetSettingsCache } from "@klh/settings";
import {
	readPostMergeStamp,
	syncSettled,
	skipHoldoffActive,
} from "../scripts/lib/activation-readiness.ts";
import { decideRuntimeSync } from "../scripts/lib/runtime-sync.ts";
import { carryGenerationPinned } from "../scripts/lib/post-merge-carry.ts";
import { runPostMergeSync } from "../scripts/lib/post-merge-runner.ts";
import {
	readBootstrapPrefix,
	suspendersPrefix,
} from "../scripts/lib/post-merge-live.ts";
import type { PostMergeRunnerDeps } from "../scripts/lib/post-merge-labels.ts";
import type { CarryDeps } from "../scripts/lib/post-merge-carry.ts";
import type { ActivationReceipt } from "../scripts/lib/service-drift.ts";
import type {
	PostMergeActivation,
	PostMergeStamp,
} from "../scripts/lib/activation-readiness.ts";

const NOW = 1_000_000_000_000;
const REV = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOARD = "com.suspenders.board";
const BUCKLE = "com.suspenders.buckle-spoke";
const SWARM = "com.suspenders.belt-swarm";
const DASH = "com.belt.dashboard";

const settledActivation = (
	requested: string[],
	verified: string[],
): PostMergeActivation => ({
	requested,
	verified,
	kickFailed: [],
	unready: [],
	needsReviewedUpgrade: [],
});

const receipt = (): ActivationReceipt => ({
	schema: "fleet.service-activation.v1",
	platform: "darwin",
	domain: "gui/501",
	manifest: "/manifest/services.yaml",
	manifestSha256: "a".repeat(64),
	services: [
		{
			label: BOARD,
			unit: "/units/board.plist",
			unitSha256: "b".repeat(64),
			arguments: ["bun", "/bin/fleet-board.ts"],
			resident: true,
			port: 7799,
		},
	],
});

/** Receipt that pins the Buckle spoke to an immutable generation — the
 * #101007 incident shape: kickstart cannot rebind it, only the reviewed
 * carry may. */
const pinnedReceipt = (): ActivationReceipt => ({
	...receipt(),
	services: [
		...receipt().services,
		{
			label: BUCKLE,
			unit: "/units/buckle.plist",
			unitSha256: "c".repeat(64),
			arguments: ["bun", "/gen/suspenders.generation-u1/bundle.js"],
			resident: true,
			port: 4101,
			generation: {
				root: "/gen/suspenders.generation-u1",
				revision: REV,
				payloadSha256: "d".repeat(64),
			},
		},
	],
});

/** Deterministic clock (#101923 shape): sleep ADVANCES it, so poll budgets
 * are consumed by iteration count, never wall time — the N1 latency
 * contract (definitive verdicts end the poll) is assertable exactly. */
const fakeClock = (start = NOW) => {
	let at = start;
	return {
		now: () => at,
		sleep: (ms: number) => {
			at += ms;
		},
	};
};

/** Record-only deps: every seam observable, nothing live. */
interface Recording {
	kicks: string[];
	probes: string[];
	inspects: string[];
	carries: string[];
	writes: PostMergeStamp[];
	applies: string[];
	publishes: number;
	loadedLooks: string[];
}
const recordingDeps = (
	over: Partial<PostMergeRunnerDeps> = {},
): { deps: PostMergeRunnerDeps; recording: Recording } => {
	const recording: Recording = {
		kicks: [],
		probes: [],
		inspects: [],
		carries: [],
		writes: [],
		applies: [],
		publishes: 0,
		loadedLooks: [],
	};
	// default clock ADVANCES on sleep (root #102617): a poll that never
	// reaches a verdict still terminates at budget exhaustion — the red
	// state fails fast instead of hanging the runner (sync loop, no
	// Playwright timeout interrupt). Explicit per-test clocks still win.
	const clock = fakeClock();
	const base: PostMergeRunnerDeps = {
		publish: () => ({ code: 0, out: "" }),
		readReceipt: () => receipt(),
		inspectLabel: (label) => ({
			label,
			state: "running",
			reason: "fixture",
			pid: 4321,
		}),
		kick: () => 0,
		probe: () => ({ ok: true, status: 200 }),
		loadedRevisionFor: () => REV,
		daemonStateFor: () => "loaded",
		probeUrlFor: () => "http://127.0.0.1:7799/api/prompt/settings",
		carry: () => ({ state: "carried", reason: "fixture settled" }),
		platform: () => "darwin",
		log: () => {},
		sleep: (ms) => clock.sleep(ms),
		now: () => clock.now(),
		writeStamp: (stamp) => recording.writes.push(stamp),
	};
	const merged: PostMergeRunnerDeps = { ...base, ...over };
	// counters wrap the MERGED seams so overrides stay observable
	const deps: PostMergeRunnerDeps = {
		...merged,
		publish: () => {
			recording.publishes += 1;
			return merged.publish();
		},
		inspectLabel: (label) => {
			recording.inspects.push(label);
			return merged.inspectLabel(label);
		},
		kick: (label) => {
			recording.kicks.push(label);
			return merged.kick(label);
		},
		probe: (url) => {
			recording.probes.push(url);
			return merged.probe(url);
		},
		loadedRevisionFor: (label) => {
			recording.loadedLooks.push(label);
			return merged.loadedRevisionFor(label);
		},
		carry: (rev) => {
			recording.carries.push(rev);
			return merged.carry(rev);
		},
	};
	return { deps, recording };
};

const stampAt = (
	main: string,
	activation?: PostMergeActivation,
): PostMergeStamp => ({
	main,
	installedAt: new Date(NOW).toISOString(),
	activation,
});

// ---------- decision core ----------

test("new head reactivates touched labels and unions unresolved priors (#101358)", () => {
	const decision = decideRuntimeSync({
		head: REV2,
		stamp: stampAt(REV, {
			...settledActivation([BUCKLE], []),
			kickFailed: [BUCKLE],
		}),
		paths: ["packages/suspenders/hooks/bin/fleet-board.ts"],
		now: NOW,
	});
	expect(decision.action).toBe("sync");
	if (decision.action !== "sync") return;
	expect(decision.labels).toContain(BOARD);
	expect(decision.labels).toContain(BUCKLE);
});

test("verified labels are NOT re-requested across heads (#101118)", () => {
	const decision = decideRuntimeSync({
		head: REV2,
		stamp: stampAt(REV, settledActivation([BOARD], [BOARD])),
		paths: ["packages/buckle/src/server.ts"],
		now: NOW,
	});
	expect(decision.action).toBe("sync");
	if (decision.action !== "sync") return;
	expect(decision.labels).toEqual([BUCKLE]);
});

test("same-head settled stamp skips; unsettled re-enters (#101007)", () => {
	expect(
		decideRuntimeSync({
			head: REV,
			stamp: stampAt(REV, settledActivation([BOARD], [BOARD])),
			paths: null,
			now: NOW,
		}),
	).toEqual({ action: "skip", reason: "up-to-date" });
	expect(
		decideRuntimeSync({
			head: REV,
			stamp: stampAt(REV, {
				...settledActivation([BOARD], []),
				unready: [BOARD],
			}),
			paths: null,
			now: NOW,
		}).action,
	).toBe("sync");
});

test("skip-kick holdoff suppresses activation inside the window only", () => {
	const stamp = stampAt(REV, { ...settledActivation([], []), skipped: true });
	expect(
		decideRuntimeSync({ head: REV, stamp, paths: null, now: NOW }),
	).toEqual({ action: "skip", reason: "skip-kick holdoff" });
	expect(
		decideRuntimeSync({ head: REV, stamp, paths: null, now: NOW + 601_000 })
			.action,
	).toBe("sync");
});

// ---------- stamp contract ----------

test("v1 stamp parses as published-not-verified; syncSettled is strict", () => {
	const stamp = readPostMergeStamp(
		JSON.stringify({ main: REV, installedAt: new Date(NOW).toISOString() }),
	);
	expect(stamp?.main).toBe(REV);
	expect(stamp?.activation).toBeUndefined();
	expect(syncSettled(stamp, REV)).toBe(false);
	expect(syncSettled(stampAt(REV, settledActivation(["a"], ["a"])), REV)).toBe(
		true,
	);
	expect(
		syncSettled(stampAt(REV, settledActivation(["a", "b"], ["a"])), REV),
	).toBe(false);
	expect(skipHoldoffActive(null, NOW)).toBe(false);
});

// ---------- runner ----------

test("same-head unready label re-inspects WITHOUT a new kick (#101118)", () => {
	const { deps, recording } = recordingDeps();
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD],
		prior: stampAt(REV, {
			...settledActivation([BOARD], []),
			unready: [BOARD],
		}),
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(recording.kicks).toEqual([]);
	expect(recording.inspects.length).toBeGreaterThan(0);
	expect(result.exit).toBe(0);
	expect(result.activation?.verified).toContain(BOARD);
});

test("failed kick retries the kick on the next run", () => {
	let kickCode = 5;
	const { deps, recording } = recordingDeps({
		kick: () => kickCode,
	});
	const first = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(first.exit).toBe(2);
	expect(first.activation?.kickFailed).toContain(BOARD);
	kickCode = 0;
	const second = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD],
		prior: recording.writes.at(-1) ?? null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(recording.kicks.length).toBe(2);
	expect(second.activation?.verified).toContain(BOARD);
});

test("skip-kick publishes without activating; carry never invoked", () => {
	const { deps, recording } = recordingDeps();
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: true,
		readinessBudgetMs: 1_000,
	});
	expect(recording.publishes).toBe(1);
	expect(recording.carries).toEqual([]);
	expect(recording.kicks).toEqual([]);
	expect(result.activation?.skipped).toBe(true);
	expect(result.exit).toBe(0);
});

test("B1(2) skip-kick run then normal same-head run activates WITHOUT republish", () => {
	const { deps, recording } = recordingDeps();
	const deferred = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD],
		prior: null,
		skipKick: true,
		readinessBudgetMs: 1_000,
	});
	expect(deferred.exit).toBe(0);
	expect(deferred.activation?.skipped).toBe(true);
	expect(deferred.activation?.verified).toEqual([]);
	expect(recording.publishes).toBe(1);
	expect(recording.kicks).toEqual([]);
	const catchUp = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD],
		prior: recording.writes.at(-1) ?? null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(recording.publishes).toBe(1); // same main — never republished
	expect(recording.kicks).toEqual([BOARD]);
	expect(catchUp.exit).toBe(0);
	expect(catchUp.activation?.verified).toContain(BOARD);
	expect(catchUp.activation?.skipped).toBeUndefined();
});

test("empty-label drift writes the all-empty ledger (publication-only)", () => {
	const { deps, recording } = recordingDeps();
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(recording.publishes).toBe(1);
	expect(recording.writes.length).toBe(1);
	expect(result.activation?.requested).toEqual([]);
	expect(result.exit).toBe(0);
});

test("B1(1) publish failure returns 1, stamp untouched, no activation seam runs", () => {
	const { deps, recording } = recordingDeps({
		publish: () => ({ code: 3, out: "syncHarness exploded" }),
	});
	// publish is overridden to fail; publishes still counted by the wrapper
	const prior = stampAt(REV, settledActivation([BOARD], [BOARD]));
	const result = runPostMergeSync(deps, {
		head: REV2,
		labels: [BOARD, BUCKLE],
		prior,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(result.exit).toBe(1);
	expect(result.activation).toBe(null);
	expect(recording.writes).toEqual([]);
	expect(recording.publishes).toBe(1);
	expect(recording.carries).toEqual([]);
	expect(recording.kicks).toEqual([]);
	expect(recording.inspects).toEqual([]);
	expect(recording.probes).toEqual([]);
	expect(recording.loadedLooks).toEqual([]);
});

test("B1(4a) generation-pinned label rides the reviewed carry, never a kick", () => {
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(recording.kicks).toEqual([]);
	expect(recording.carries).toEqual([REV]);
	expect(recording.loadedLooks).toContain(BUCKLE);
	expect(result.exit).toBe(0);
	expect(result.activation?.verified).toContain(BUCKLE);
});

test("B1(4b) carried but unready probe: pinned held for reviewed upgrade", () => {
	const clock = fakeClock();
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		probe: () => ({ ok: false, status: 503 }),
		now: () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
		pollIntervalMs: 100,
	});
	expect(recording.carries).toEqual([REV]);
	expect(recording.kicks).toEqual([]);
	expect(recording.probes.length).toBe(1); // definitive 503 ends the poll (N1)
	expect(result.exit).toBe(2);
	expect(result.activation?.verified).toEqual([]);
	expect(result.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
});

test("B1(4c) pending and failed carry never kick; ledger holds the label", () => {
	for (const state of ["pending", "failed"] as const) {
		const { deps, recording } = recordingDeps({
			readReceipt: () => pinnedReceipt(),
			carry: () => ({ state, reason: `fixture ${state}` }),
		});
		const result = runPostMergeSync(deps, {
			head: REV,
			labels: [BUCKLE],
			prior: null,
			skipKick: false,
			readinessBudgetMs: 1_000,
		});
		expect(recording.carries).toEqual([REV]);
		expect(recording.kicks).toEqual([]);
		expect(recording.probes).toEqual([]);
		expect(result.exit).toBe(2);
		expect(result.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
	}
});

test("B1(4d) same-head recovery: settled carry on the retry run", () => {
	const held = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		probe: () => ({ ok: false, status: 503 }),
	});
	const first = runPostMergeSync(held.deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
		pollIntervalMs: 100,
	});
	expect(first.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
	// recovery: the gateway answers healthy — the pinned label settles
	const retry = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		probe: () => ({ ok: true, status: 200 }),
	});
	const second = runPostMergeSync(retry.deps, {
		head: REV,
		labels: [BUCKLE],
		prior: held.recording.writes.at(-1) ?? null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(retry.recording.carries).toEqual([REV]); // carry retried, kick never
	expect(retry.recording.kicks).toEqual([]);
	expect(second.exit).toBe(0);
	expect(second.activation?.verified).toContain(BUCKLE);
	expect(second.activation?.needsReviewedUpgrade).toEqual([]);
});

test("N1 no probe URL terminates promptly without repeated identity polls", () => {
	const clock = fakeClock();
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		probeUrlFor: () => null,
		now: () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 30_000,
		pollIntervalMs: 1_000,
	});
	// clock-driven: even pre-fix the run terminates (at budget exhaustion,
	// 31 polls) — the FIX is the 1-look/0-probe prompt verdict.
	expect(recording.loadedLooks).toHaveLength(1); // final verdict, no poll
	expect(recording.probes).toEqual([]);
	expect(result.exit).toBe(2);
	expect(result.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
});

test("N1 connection-refused (status 0) keeps polling inside the budget", () => {
	const clock = fakeClock();
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		probe: () => ({ ok: false, status: 0 }),
		now: () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 30_000,
		pollIntervalMs: 1_000,
	});
	expect(recording.probes.length).toBe(31); // budget consumed by iteration
	expect(result.exit).toBe(2);
	expect(result.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
});

test("N1 delayed identity settles inside the budget (null,null,expected → probe)", () => {
	const clock = fakeClock();
	const loadedSeq = [null, null, REV] as const;
	let look = 0;
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		loadedRevisionFor: () =>
			look < loadedSeq.length ? loadedSeq[look++] : REV,
		probe: () => ({ ok: true, status: 200 }),
		now: () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 30_000,
		pollIntervalMs: 1_000,
	});
	// 3 identity observations (poll past two unobservable reads), then the
	// probe settles it — the parent's bounded identity settling preserved
	expect(recording.loadedLooks.length).toBe(3);
	expect(recording.probes.length).toBe(1);
	expect(clock.now() - NOW).toBe(2_000); // two poll iterations, not instant
	expect(result.exit).toBe(0);
	expect(result.activation?.verified).toContain(BUCKLE);
});

test("N1 never-observable identity exhausts the budget as a truthful failure", () => {
	const clock = fakeClock();
	const { deps, recording } = recordingDeps({
		readReceipt: () => pinnedReceipt(),
		loadedRevisionFor: () => null,
		probe: () => ({ ok: true, status: 200 }),
		now: () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 30_000,
		pollIntervalMs: 1_000,
	});
	expect(recording.loadedLooks.length).toBe(31); // budget exhausted polling
	expect(recording.probes).toEqual([]); // identity never proved → no probe
	expect(result.exit).toBe(2);
	expect(result.activation?.needsReviewedUpgrade).toEqual([BUCKLE]);
});

test("N2 non-darwin host defers activation truthfully — no launchd, no storm", () => {
	const { deps, recording } = recordingDeps({
		platform: () => "linux",
	});
	const result = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD, BUCKLE],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	// no launchd seam ever runs (kick/carry/inspect/probe/loadedRevision)
	expect(recording.kicks).toEqual([]);
	expect(recording.carries).toEqual([]);
	expect(recording.inspects).toEqual([]);
	expect(recording.probes).toEqual([]);
	expect(recording.loadedLooks).toEqual([]);
	expect(result.exit).toBe(0); // truthful publication success, not a storm
	expect(result.activation?.verified).toEqual([]);
	expect(result.activation?.needsReviewedUpgrade).toEqual([]);
	expect(result.activation?.note).toContain("not darwin");
});

// ---------- B1(3): partial multi-label + retry-only-missing ----------

/** Three-label fixture: BOARD verifies, SWARM's kickstart exits 5,
 * DASH's probe answers a definitive 500 (unready, not kick-failed). */
const partialWorld = () => {
	let swarmKick = 5;
	let dashProbeOk = false;
	const { deps, recording } = recordingDeps({
		kick: (label) => (label === SWARM ? swarmKick : 0),
		probe: (url) =>
			url.includes("7791")
				? { ok: dashProbeOk, status: dashProbeOk ? 200 : 500 }
				: { ok: true, status: 200 },
		probeUrlFor: (label) =>
			label === DASH
				? "http://127.0.0.1:7791/api/health"
				: "http://127.0.0.1:7799/api/prompt/settings",
	});
	return {
		deps,
		recording,
		recover: () => {
			swarmKick = 0;
			dashProbeOk = true;
		},
	};
};

test("B1(3a) partial multi-label success records the truthful ledger", () => {
	const { deps } = partialWorld();
	const first = runPostMergeSync(deps, {
		head: REV,
		labels: [BOARD, SWARM, DASH],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	expect(first.exit).toBe(2);
	expect(first.activation?.verified).toEqual([BOARD]);
	expect(first.activation?.kickFailed).toEqual([SWARM]);
	expect(first.activation?.unready).toEqual([DASH]);
	expect(first.activation?.needsReviewedUpgrade).toEqual([]);
});

test("B1(3b) second run retains verified, retries only kick-failed, re-inspects unready", () => {
	const world = partialWorld();
	runPostMergeSync(world.deps, {
		head: REV,
		labels: [BOARD, SWARM, DASH],
		prior: null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	const kicksAfterFirst = world.recording.kicks.length;
	const probesAfterFirst = world.recording.probes.length;
	world.recover(); // swarm kick succeeds, dash probe turns healthy
	const second = runPostMergeSync(world.deps, {
		head: REV,
		labels: [BOARD, SWARM, DASH],
		prior: world.recording.writes.at(-1) ?? null,
		skipKick: false,
		readinessBudgetMs: 1_000,
	});
	// BOARD was verified on this main: retained, no seam re-driven for it
	expect(second.activation?.verified).toContain(BOARD);
	expect(world.recording.probes.length - probesAfterFirst).toBe(2); // dash + swarm only
	expect(world.recording.kicks.length - kicksAfterFirst).toBe(1); // swarm only
	expect(world.recording.kicks.at(-1)).toBe(SWARM);
	expect(second.exit).toBe(0);
	expect(second.activation?.kickFailed).toEqual([]);
	expect(second.activation?.unready).toEqual([]);
});

// ---------- carry over real plutil seams ----------

// N3: one world PER TEST through the kit lifecycle — module scope leaked
// the fixture dirs every suite run. carryWorldFixture() mints it AND
// self-registers for afterEach cleanup (an assertion failure still
// cleans — root #102613/#102620: never a trailing-clean-only shape).
const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterEach(() => {
	while (worlds.length > 0) worlds.pop()?.clean();
});
function carryWorldFixture() {
	const world = scratchWorld({ prefix: "w2546-carry-" });
	worlds.push(world);
	return { world, root: world.repo };
}

/** Real plutil conversion (exactly the live seam). */
const throughPlutil = (bytes: string, format: string): string | null => {
	const p = Bun.spawnSync(
		["/usr/bin/plutil", "-convert", format, "-o", "-", "-"],
		{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
	);
	return p.exitCode === 0 ? p.stdout.toString() : null;
};

const unitJsonFor = (revision: string): string =>
	JSON.stringify({
		Label: BUCKLE,
		ProgramArguments: [
			"/usr/local/bin/bun",
			`/gen/suspenders.generation-${revision}-u1/.harness/packages/buckle/src/server.bundle.js`,
		],
	});

const proposalFor = (unit: string, candidate: string) => ({
	unit,
	beforeUnitSha256: "0".repeat(64),
	beforeReceiptSha256: "0".repeat(64),
	processSha256: "0".repeat(64),
	candidate,
	candidateSha256: "0".repeat(64),
	arguments: JSON.parse(candidate).ProgramArguments as string[],
	generation: { root: "/gen", revision: REV, payloadSha256: "0".repeat(64) },
	manifest: "/manifest/services.yaml",
});

const carryFixture = (root: string, over: Partial<CarryDeps> = {}) => {
	const unitPath = join(
		root,
		`unit-${Math.random().toString(36).slice(2)}.plist`,
	);
	const candidate = unitJsonFor(REV);
	const applied: string[] = [];
	const deps: CarryDeps = {
		prepare: () => proposalFor(unitPath, candidate),
		readUnit: () => readFileSync(unitPath, "utf8"),
		unitToJson: (bytes) => throughPlutil(bytes, "json"),
		publishedRevision: () => REV,
		loadedRevision: () => REV,
		daemonState: () => "loaded",
		applyReviewed: (sha) => {
			applied.push(sha);
			return { status: "ok", note: "fixture applied" };
		},
		log: () => {},
		...over,
	};
	return { unitPath, candidate, deps, applied };
};

test("settled carry applies nothing (disk AND daemon on the revision)", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root);
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(0);
	world.clean();
});

test("failed-load retry: disk advanced, daemon old → fenced re-apply (#101172)", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root, { loadedRevision: () => REV2 });
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(1);
	world.clean();
});

test("unknown daemon state with advanced disk stays pending (#101322 seam 2)", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root, {
		loadedRevision: () => REV2,
		daemonState: () => "unknown",
	});
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("pending");
	expect(f.applied.length).toBe(0);
	world.clean();
});

test("tampered disk unit refuses the no-op retry (all-keys equality)", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root, { loadedRevision: () => REV2 });
	const tampered = JSON.parse(unitJsonFor(REV)) as Record<string, unknown>;
	tampered.EnvironmentVariables = { EVIL: "1" };
	writeFileSync(
		f.unitPath,
		throughPlutil(JSON.stringify(tampered), "xml1") ?? "",
	);
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).not.toBe("carried");
	expect(f.applied.length).toBe(0);
	world.clean();
});

test("apply throw converts to failed, never propagates (#101322 seam 3)", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root, {
		loadedRevision: () => REV2,
		applyReviewed: () => {
			throw new Error("Reviewed gateway registration failed");
		},
	});
	writeFileSync(f.unitPath, throughPlutil(unitJsonFor(REV2), "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("failed");
	world.clean();
});

test("fresh carry: disk on old revision → generation-only apply", () => {
	const { world, root } = carryWorldFixture();
	const f = carryFixture(root);
	writeFileSync(f.unitPath, throughPlutil(unitJsonFor(REV2), "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(1);
	world.clean();
});

// ---------- fleet-loop same-head re-entry (#101149 parent) ----------

test("createRuntimeSync re-enters on same-head unsettled stamp", async () => {
	const { createRuntimeSync } = await import(
		"../hooks/lib/fleet-loop/runtime-sync.ts"
	);
	const { world, root } = carryWorldFixture();
	// hermetic maintenance gate: the machine setting may be flipped to
	// false by operations (it was, during live acceptance) — pin the env
	// override ON for this test and restore it either way (#102613).
	const hadMaintenance = process.env.SUSPENDERS_MAINTENANCE;
	process.env.SUSPENDERS_MAINTENANCE = "1";
	try {
		const statePath = join(root, "loop-state.json");
		writeFileSync(
			statePath,
			JSON.stringify(
				stampAt(REV, {
					...settledActivation([BOARD], []),
					unready: [BOARD],
				}),
			),
		);
		const spawned: string[][] = [];
		const deps = {
			REPO: root,
			MAIN: "main",
			log: () => {},
			sh: (cmd: string[]) => (cmd[0] === "git" ? REV : ""),
		};
		const { runtimeSync } = createRuntimeSync(
			deps as unknown as Parameters<typeof createRuntimeSync>[0],
			{
				statePath,
				spawn: (cmd: string[]) => {
					spawned.push(cmd);
					return { code: 0, out: "" };
				},
			},
		);
		const result = runtimeSync();
		expect(result.ran).toBe(true);
		expect(spawned.length).toBe(1);
	} finally {
		if (hadMaintenance === undefined) delete process.env.SUSPENDERS_MAINTENANCE;
		else process.env.SUSPENDERS_MAINTENANCE = hadMaintenance;
		world.clean();
	}
});

// ---------- prefix knob designated home (W2674) ----------

// The shared adapter's prefix (W2546.1) reads through its designated home
// (KNOB_REGISTRY row SUSPENDERS_PREFIX → paths.suspenders_prefix), never a
// direct env read: the settings row wins, the schema default's ~/ expands
// against HOME, and the mapped env var stays the transition override.
test("suspendersPrefix: settings row wins, ~/ default expands, env stays override", () => {
	const dir = mkdtempSync(join(tmpdir(), "w2674-prefix-"));
	const file = join(dir, "settings.json");
	const hadSettings = process.env.KLH_SETTINGS;
	const hadPrefix = process.env.SUSPENDERS_PREFIX;
	const hadHome = process.env.HOME;
	const scratchHome = join(dir, "home");
	process.env.KLH_SETTINGS = file;
	delete process.env.SUSPENDERS_PREFIX;
	try {
		// no settings file: the schema default (~/.claude/hooks/suspenders)
		// expands against HOME
		process.env.HOME = scratchHome;
		resetSettingsCache();
		expect(suspendersPrefix()).toBe(
			join(scratchHome, ".claude/hooks/suspenders"),
		);
		// settings row wins over the default
		writeFileSync(
			file,
			JSON.stringify({ paths: { suspenders_prefix: "/opt/prefix" } }),
		);
		resetSettingsCache();
		expect(suspendersPrefix()).toBe("/opt/prefix");
		// the mapped env var stays the transition override (env-map row)
		process.env.SUSPENDERS_PREFIX = "/env/prefix";
		resetSettingsCache();
		expect(suspendersPrefix()).toBe("/env/prefix");
	} finally {
		if (hadSettings === undefined) delete process.env.KLH_SETTINGS;
		else process.env.KLH_SETTINGS = hadSettings;
		if (hadPrefix === undefined) delete process.env.SUSPENDERS_PREFIX;
		else process.env.SUSPENDERS_PREFIX = hadPrefix;
		if (hadHome === undefined) delete process.env.HOME;
		else process.env.HOME = hadHome;
		resetSettingsCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------- W2950: the upgrade-window bootstrap prefix read ----------

// The machine settings.json may carry keys an OLDER installed generation's
// schema does not know (live witness: generation-ea80700 rejected `runner`
// and degraded the whole document to defaults). The bootstrap reads ONLY
// the leaf it consumes, tolerantly: unknown keys pass, a present-but-
// invalid prefix refuses (fail closed), absence falls to the default.
test.describe("readBootstrapPrefix (W2950)", () => {
	const OLD = {
		runner: { control_url: "http://127.0.0.1:7810", state_dir: "/tmp/r" },
		paths: { suspenders_prefix: "/opt/prefix" },
	};
	test("unknown settings keys pass — a newer source's keys are not invalid FOR the bootstrap", () => {
		expect(readBootstrapPrefix(OLD, undefined)).toEqual({
			kind: "ok",
			prefix: "/opt/prefix",
		});
	});
	test("absence falls to the schema default; env stays the override", () => {
		expect(readBootstrapPrefix({}, undefined)).toEqual({
			kind: "ok",
			prefix: "~/.claude/hooks/suspenders",
		});
		expect(readBootstrapPrefix(OLD, "/env/prefix")).toEqual({
			kind: "ok",
			prefix: "/env/prefix",
		});
	});
	test("present-but-invalid prefix refuses (fail closed, never a silent default)", () => {
		const verdict = readBootstrapPrefix(
			{ paths: { suspenders_prefix: 42 } },
			undefined,
		);
		expect(verdict.kind).toBe("refuse");
		if (verdict.kind === "refuse")
			expect(verdict.reason).toContain("invalid paths.suspenders_prefix");
	});
	test("a non-object paths section refuses", () => {
		expect(readBootstrapPrefix({ paths: "/not/a/dir" }, undefined).kind).toBe(
			"refuse",
		);
	});
});

test("suspendersPrefix reads the machine file tolerantly and fails closed (W2950)", () => {
	const dir = mkdtempSync(join(tmpdir(), "w2950-prefix-"));
	const file = join(dir, "settings.json");
	const hadSettings = process.env.KLH_SETTINGS;
	const hadPrefix = process.env.SUSPENDERS_PREFIX;
	process.env.KLH_SETTINGS = file;
	delete process.env.SUSPENDERS_PREFIX;
	try {
		// keys an older installed generation's schema rejects still publish
		writeFileSync(
			file,
			JSON.stringify({
				runner: { control_url: "http://127.0.1:7810" },
				paths: { suspenders_prefix: "/opt/prefix" },
			}),
		);
		expect(suspendersPrefix()).toBe("/opt/prefix");
		// a present-but-invalid prefix refuses the sync loudly
		writeFileSync(file, JSON.stringify({ paths: { suspenders_prefix: 7 } }));
		expect(() => suspendersPrefix()).toThrow(
			/invalid paths\.suspenders_prefix/,
		);
		// malformed JSON refuses rather than publishing onto an unknown posture
		writeFileSync(file, "{not json");
		expect(() => suspendersPrefix()).toThrow(
			/machine settings\.json unreadable/,
		);
	} finally {
		if (hadSettings === undefined) delete process.env.KLH_SETTINGS;
		else process.env.KLH_SETTINGS = hadSettings;
		if (hadPrefix === undefined) delete process.env.SUSPENDERS_PREFIX;
		else process.env.SUSPENDERS_PREFIX = hadPrefix;
		rmSync(dir, { recursive: true, force: true });
	}
});
