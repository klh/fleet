// test/starter-materialize.test.ts — W458.3: the materialization contract.
// Covered: auth recheck at materialization (fail-closed), freshness +
// compatibility filter with observable refusals, rank by measured outcomes,
// native-fork vs reconstructed route recording, identity separation from
// provenance, outcome log append + read.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	materializeStarter,
	recordOutcome,
	readOutcomes,
	type MaterializeRequest,
} from "../hooks/lib/starter-materialize.ts";
import {
	promoteStarter,
	writeGrants,
	appendRevocation,
} from "../hooks/lib/starter-distribution.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "w4583t-"));

const mk = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "fleet-orientation",
	version: 1,
	createdAt: "2026-10-11T00:00:00.000Z",
	instructions: "Shared prefix.",
	skillVersions: {},
	findings: ["finding.x"],
	sourceRevision: "7a411950011223344556648899aabbccddeeff0",
	compatibility: { harnesses: ["claude"], models: ["glm-5.3-flash"] },
	provenance: {
		authorSid: "autow458-1",
		promotedBy: "autow458-5",
		evalRef: "blam://e/v1",
	},
	evals: [{ name: "s", passed: true, at: "2026-10-11T00:00:00.000Z" }],
	...over,
});

const req = (
	repo: string,
	over: Partial<MaterializeRequest> = {},
): MaterializeRequest => ({
	repo,
	actor: "dev1",
	task: "W900",
	harness: "claude",
	model: "glm-5.3-flash",
	identity: { sid: "lane-77", task: "W900", worktree: "/tmp/wt-77" },
	...over,
});

const setup = (repo: string): void => {
	writeGrants(repo, { promoters: ["p"], revokers: ["r"], readers: ["dev1"] });
	promoteStarter(repo, "p", mk() as never);
};

describe("starter-materialize: contract happy path", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("auth recheck + filter + rank + route, with evidence", () => {
		setup(repo);
		const m = materializeStarter(req(repo));
		expect("refused" in m).toBe(false);
		if ("refused" in m) return;
		expect(m.route).toBe("native-fork");
		expect(m.starter.id).toBe("fleet-orientation");
		expect(m.starter.version).toBe(1);
		expect(m.prompt).toBe("Shared prefix.");
		expect(m.evidence.authRecheck).toBe("ok");
		expect(m.evidence.ranked).toHaveLength(1);
		expect(m.evidence.refusals).toEqual([]);
	});

	test("rank prefers measured outcomes, then newest version", () => {
		setup(repo);
		const second = mk({
			id: "second-starter",
			version: 3,
			instructions: "Second starter prefix.",
			evals: [
				{ name: "a", passed: true, at: "2026-10-11T00:00:00.000Z" },
				{ name: "b", passed: false, at: "2026-10-11T00:00:00.000Z" },
			],
		});
		promoteStarter(repo, "p", second as never);
		const m = materializeStarter(req(repo));
		if ("refused" in m) return;
		// fleet-orientation 1.0 beats second-starter 0.5
		expect(m.starter.id).toBe("fleet-orientation");
		expect(m.evidence.ranked[0].passRate).toBe(1);
	});

	test("pinned id ranks within one starter only", () => {
		setup(repo);
		const pinned = materializeStarter(req(repo, { id: "second-starter" }));
		expect("refused" in pinned).toBe(true);
		if (!("refused" in pinned)) return;
		expect(pinned.refused).toMatch(/second-starter/);
	});
});
describe("starter-materialize: refusals", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("no readers grant = refused (auth recheck, fail-closed)", () => {
		writeGrants(repo, { promoters: ["p"], revokers: [], readers: [] });
		promoteStarter(repo, "p", mk() as never);
		const m = materializeStarter(req(repo));
		expect("refused" in m).toBe(true);
	});

	test("stale artifact refused under the freshness knob", () => {
		setup(repo);
		const m = materializeStarter(req(repo), {
			now: () => Date.parse("2026-12-20T00:00:00.000Z"),
		});
		expect("refused" in m).toBe(true);
	});

	test("incompatible harness/model refused", () => {
		setup(repo);
		const m = materializeStarter(req(repo, { model: "other-model" }));
		expect("refused" in m).toBe(true);
	});

	test("revoked starter refused at materialization", () => {
		setup(repo);
		appendRevocation(repo, "r", {
			id: "fleet-orientation",
			reason: "regression",
		});
		const m = materializeStarter(req(repo));
		expect("refused" in m).toBe(true);
		if ("refused" in m) expect(m.refused).toMatch(/revoked/);
	});

	test("identity reuse from provenance refused", () => {
		setup(repo);
		const m = materializeStarter(
			req(repo, {
				identity: { sid: "autow458-1", task: "W900", worktree: "/w" },
			}),
		);
		expect("refused" in m).toBe(true);
		if ("refused" in m) expect(m.refused).toMatch(/fresh identity required/);
	});
});
describe("starter-materialize: routes + outcomes", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("forkless harness = reconstructed route, recorded", () => {
		setup(repo);
		promoteStarter(
			repo,
			"p",
			mk({
				id: "grok-starter",
				compatibility: { harnesses: ["grok"], models: ["glm-5.3-flash"] },
			}) as never,
		);
		const m = materializeStarter(req(repo, { harness: "grok" }));
		expect("refused" in m).toBe(false);
		if ("refused" in m) return;
		expect(m.route).toBe("reconstructed");
		expect(m.starter.id).toBe("grok-starter");
	});

	test("outcome log: append + read roundtrip", () => {
		setup(repo);
		const m = materializeStarter(req(repo));
		if ("refused" in m) throw new Error("expected materialization");
		recordOutcome(repo, {
			task: "W900",
			sid: "lane-77",
			starter: m.starter,
			route: m.route,
			cache: { writes: 1200, reads: 49000, misses: 3 },
			costUsd: 0.11,
			outcome: "verified",
			at: "2026-10-11T00:00:00.000Z",
		});
		const rows = readOutcomes(repo);
		expect(rows).toHaveLength(1);
		expect(rows[0].route).toBe("native-fork");
		expect(rows[0].cache?.reads).toBe(49000);
		expect(readOutcomes(scratch())).toHaveLength(0);
	});
});
