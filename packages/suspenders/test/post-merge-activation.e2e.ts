// test/post-merge-activation.e2e.ts — W2546 hermetic regression: the
// truthful post-merge activation. Every owner escalation is a falsifiable
// case against REAL seams on isolated fixtures (temp HOME, no live
// launchd, no machine config): the runner contract (post-merge-runner),
// the decision core (runtime-sync), the carry (post-merge-carry over real
// plutil-parsed plist units), and the fleet-loop same-head re-entry. No
// mock ever returns "carried" unconditionally — every carry outcome is
// forced by fixture state.
import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	readPostMergeStamp,
	syncSettled,
	skipHoldoffActive,
} from "../scripts/lib/activation-readiness.ts";
import { decideRuntimeSync } from "../scripts/lib/runtime-sync.ts";
import { carryGenerationPinned } from "../scripts/lib/post-merge-carry.ts";
import { runPostMergeSync } from "../scripts/lib/post-merge-runner.ts";
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

/** Record-only deps: every seam observable, nothing live. */
interface Recording {
	kicks: string[];
	probes: string[];
	inspects: string[];
	carries: string[];
	writes: PostMergeStamp[];
	applies: string[];
	publishes: number;
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
	};
	const deps: PostMergeRunnerDeps = {
		publish: () => {
			recording.publishes += 1;
			return { code: 0, out: "" };
		},
		readReceipt: () => receipt(),
		inspectLabel: (label) => {
			recording.inspects.push(label);
			return { label, state: "running", reason: "fixture", pid: 4321 };
		},
		kick: (label) => {
			recording.kicks.push(label);
			return 0;
		},
		probe: (url) => {
			recording.probes.push(url);
			return { ok: true, status: 200 };
		},
		loadedRevisionFor: () => REV,
		daemonStateFor: () => "loaded",
		probeUrlFor: () => "http://127.0.0.1:7799/api/prompt/settings",
		carry: (rev) => {
			recording.carries.push(rev);
			return { state: "carried", reason: "fixture settled" };
		},
		log: () => {},
		sleep: () => {},
		now: () => NOW,
		writeStamp: (stamp) => recording.writes.push(stamp),
		...over,
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
		kick: (label) => {
			recording.kicks.push(label);
			return kickCode;
		},
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

// ---------- carry over real plutil seams ----------

// test-kit scratch world (W1135.1.3): isolated HOME + repo, kit teardown —
// the carry fixtures write their plutil units under it
const carryWorld = scratchWorld({ prefix: "w2546-carry-" });
const tmpRoot = carryWorld.repo;

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

const carryFixture = (over: Partial<CarryDeps> = {}) => {
	const unitPath = join(
		tmpRoot,
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
	const f = carryFixture();
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(0);
});

test("failed-load retry: disk advanced, daemon old → fenced re-apply (#101172)", () => {
	const f = carryFixture({ loadedRevision: () => REV2 });
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(1);
});

test("unknown daemon state with advanced disk stays pending (#101322 seam 2)", () => {
	const f = carryFixture({
		loadedRevision: () => REV2,
		daemonState: () => "unknown",
	});
	writeFileSync(f.unitPath, throughPlutil(f.candidate, "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("pending");
	expect(f.applied.length).toBe(0);
});

test("tampered disk unit refuses the no-op retry (all-keys equality)", () => {
	const f = carryFixture({ loadedRevision: () => REV2 });
	const tampered = JSON.parse(unitJsonFor(REV)) as Record<string, unknown>;
	tampered.EnvironmentVariables = { EVIL: "1" };
	writeFileSync(
		f.unitPath,
		throughPlutil(JSON.stringify(tampered), "xml1") ?? "",
	);
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).not.toBe("carried");
	expect(f.applied.length).toBe(0);
});

test("apply throw converts to failed, never propagates (#101322 seam 3)", () => {
	const f = carryFixture({
		loadedRevision: () => REV2,
		applyReviewed: () => {
			throw new Error("Reviewed gateway registration failed");
		},
	});
	writeFileSync(f.unitPath, throughPlutil(unitJsonFor(REV2), "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("failed");
});

test("fresh carry: disk on old revision → generation-only apply", () => {
	const f = carryFixture();
	writeFileSync(f.unitPath, throughPlutil(unitJsonFor(REV2), "xml1") ?? "");
	const result = carryGenerationPinned(f.deps, REV);
	expect(result.state).toBe("carried");
	expect(f.applied.length).toBe(1);
});

// ---------- fleet-loop same-head re-entry (#101149 parent) ----------

test("createRuntimeSync re-enters on same-head unsettled stamp", async () => {
	const { createRuntimeSync } = await import(
		"../hooks/lib/fleet-loop/runtime-sync.ts"
	);
	const statePath = join(tmpRoot, "loop-state.json");
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
		REPO: tmpRoot,
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
});
