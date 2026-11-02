// test/install-activate-step.e2e.ts — W2546 #101772: the meaningful
// EXECUTED-step regressions for the default-plan gateway activation,
// through the real activateGateway impl over injected process seams
// (hermetic: no live launchd, no real children). The seam shapes are the
// production ones (ActivateDeps = carryAdapter/gatewayReadiness shapes).
// The CLI-surface cases (plan rows, dry-run inertness, fresh-host skip)
// stay in install-activate-gateway.e2e.ts.
import { expect, test } from "@playwright/test";
import { mkdirSync as fsMkdir, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { pollProbe } from "../scripts/lib/post-merge-labels.ts";
import {
	activateGateway,
	type ActivateDeps,
} from "../scripts/install/install-activate-gateway.ts";
import type { CarryDeps } from "../scripts/lib/post-merge-carry.ts";
import type { PollDeps } from "../scripts/lib/post-merge-live.ts";
import type { GatewayUpgrade } from "../scripts/upgrade-gateway.ts";

const REV = "a".repeat(40);
const REV2 = "b".repeat(40);
const LABEL = "com.suspenders.buckle-spoke";
const bundlePath = (rev: string): string =>
	`/gen/suspenders.generation-${rev}-u1/.harness/packages/buckle/src/server.bundle.js`;

// Kit lifecycle (root #102613/#102620): trailing world.clean() leaks the
// fixture dirs when an assertion fails mid-test — the shared afterEach
// always runs, an assertion failure still cleans.
const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterEach(() => {
	while (worlds.length > 0) worlds.pop()?.clean();
});
const worldFixture = (prefix: string): ReturnType<typeof scratchWorld> => {
	const world = scratchWorld({ prefix: `${prefix}-` });
	worlds.push(world);
	return world;
};

/** Publish the harness receipt at a prefix (mkdir on demand). */
const publishReceipt = (prefix: string, rev: string): void => {
	fsMkdir(prefix, { recursive: true });
	writeFileSync(
		join(prefix, "harness-receipt.json"),
		JSON.stringify({
			schema: "fleet.harness.v1",
			revision: rev,
			payloadSha256: "2".repeat(64),
		}),
	);
};

/** Real pollProbe over injected seams — the exact bounded loop the
 * production gatewayReadiness rides (#101757/#101816: refused = status 0
 * keeps polling; a definitive HTTP answer ends it). */
function readinessFrom(
	probeNext: () => { ok: boolean; status: number },
	budgetMs = 5_000,
): { ready: boolean; reason: string } {
	// fake monotonic clock: sleep advances it, so the budget is consumed
	// by the poll count, never wall time (#101923 — no busy-spin)
	let clock = 0;
	let calls = 0;
	const polls: PollDeps = {
		inspectLabel: () => ({
			label: LABEL,
			state: "running",
			reason: "fixture",
			pid: 4321,
		}),
		probe: () => {
			calls += 1;
			return probeNext();
		},
		now: () => clock,
		sleep: (ms) => {
			clock += ms;
		},
	};
	const probed = pollProbe(polls, "http://127.0.0.1:4101/health", budgetMs, 1);
	return probed.ok
		? { ready: true, reason: `probe ok (${calls} calls)` }
		: {
				ready: false,
				reason: `probe failed (status ${probed.status}, ${calls} calls)`,
			};
}

/** The fixture's staged proposal (production GatewayUpgrade shape). */
const proposalFor = (unit: string, rev: string): GatewayUpgrade => {
	const candidate = JSON.stringify({
		Label: LABEL,
		ProgramArguments: ["/usr/local/bin/bun", bundlePath(rev)],
	});
	return {
		unit,
		beforeUnitSha256: "0".repeat(64),
		beforeReceiptSha256: "0".repeat(64),
		processSha256: "0".repeat(64),
		candidate,
		candidateSha256: "1".repeat(64),
		arguments: JSON.parse(candidate).ProgramArguments,
		generation: { root: "/gen", revision: rev, payloadSha256: "2".repeat(64) },
		manifest: "/manifest/services.yaml",
	};
};

/** The executed step context (production StepContext shape). */
const ctxFor = (over: Partial<Parameters<typeof activateGateway>[0]> = {}) =>
	({
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
		repo: "/repo",
		prefix: "/prefix",
		shimBin: "/unused",
		llmHome: "/unused",
		home: "/home",
		wireRepo: null,
		...over,
	}) as Parameters<typeof activateGateway>[0];

/** Instrumented ActivateDeps: every seam observable, nothing live. */
const stepDeps = (
	proposal: GatewayUpgrade,
	over: {
		loadedRevision?: () => string | null;
		daemonState?: () => "loaded" | "absent" | "unknown";
		applyReviewed?: CarryDeps["applyReviewed"];
		probeNext?: () => { ok: boolean; status: number };
	},
): { deps: ActivateDeps; applied: string[]; staged: string[] } => {
	const applied: string[] = [];
	const staged: string[] = [];
	const adapter: CarryDeps = {
		prepare: () => {
			staged.push(String(staged.length + 1));
			return proposal;
		},
		readUnit: () => proposal.candidate,
		unitToJson: (bytes: string) => bytes,
		publishedRevision: () => proposal.generation.revision,
		loadedRevision: over.loadedRevision ?? (() => proposal.generation.revision),
		daemonState: over.daemonState ?? (() => "loaded"),
		applyReviewed:
			over.applyReviewed ??
			((sha: string) => {
				applied.push(sha);
				return { status: "ok", note: "fixture applied" };
			}),
		log: () => {},
	};
	return {
		applied,
		staged,
		deps: {
			adapter: () => adapter,
			readiness: () =>
				readinessFrom(over.probeNext ?? (() => ({ ok: true, status: 200 }))),
		},
	};
};

test("executed step: stale daemon applies the carry ONCE, ready verified", async () => {
	const world = worldFixture("w2546-stale");
	publishReceipt(join(world.home, "prefix"), REV);
	const proposal = proposalFor(join(world.home, "unit.plist"), REV);
	const { deps, applied, staged } = stepDeps(proposal, {
		loadedRevision: () => REV2,
	});
	const result = await activateGateway(
		ctxFor({ prefix: join(world.home, "prefix") }),
		deps,
	);
	expect(result.status).toBe("ok");
	expect(staged).toHaveLength(1);
	expect(applied).toHaveLength(1);
	expect(result.detail).toBeTruthy();
});

test("executed step: same-generation rerun never re-applies", async () => {
	const world = worldFixture("w2546-same");
	publishReceipt(join(world.home, "prefix"), REV);
	const proposal = proposalFor(join(world.home, "unit.plist"), REV);
	const { deps, applied } = stepDeps(proposal, { loadedRevision: () => REV });
	const ctx = ctxFor({ prefix: join(world.home, "prefix") });
	expect((await activateGateway(ctx, deps)).status).toBe("ok");
	expect((await activateGateway(ctx, deps)).status).toBe("ok");
	expect(applied).toHaveLength(0);
});

test("executed step: delayed-ready settles inside the budget without another apply", async () => {
	const world = worldFixture("w2546-delay");
	publishReceipt(join(world.home, "prefix"), REV);
	const proposal = proposalFor(join(world.home, "unit.plist"), REV);
	let probes = 0;
	const { deps, applied } = stepDeps(proposal, {
		loadedRevision: () => REV2,
		probeNext: () => {
			probes += 1;
			return probes < 3 ? { ok: false, status: 0 } : { ok: true, status: 200 };
		},
	});
	const result = await activateGateway(
		ctxFor({ prefix: join(world.home, "prefix") }),
		deps,
	);
	expect(result.status).toBe("ok");
	expect(applied).toHaveLength(1);
	expect(probes).toBeGreaterThanOrEqual(3);
});

test("executed step: exhausted readiness budget fails truthfully", async () => {
	const world = worldFixture("w2546-exhaust");
	publishReceipt(join(world.home, "prefix"), REV);
	const proposal = proposalFor(join(world.home, "unit.plist"), REV);
	const { deps, applied } = stepDeps(proposal, {
		loadedRevision: () => REV2,
		probeNext: () => ({ ok: false, status: 0 }),
	});
	const result = await activateGateway(
		ctxFor({ prefix: join(world.home, "prefix") }),
		deps,
	);
	expect(result.status).toBe("failed");
	expect(result.note).toContain("unready");
	expect(applied).toHaveLength(1);
});
