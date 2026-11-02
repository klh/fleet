// merge-defer.e2e.ts — W2561: the per-item merge defer as a contract. Pure
// predicate coverage (readMergeDefer/mergeDeferredActive/deferredBranches),
// controller enforcement (set-aside + NEED_DECISION, the enforceMergeHold
// role), and the runtime-sync gate integration (anyMergeDeferred defers the
// sweep; createRuntimeSync honors it without spawning the runner). The
// mergeOne/FLUSH-DEFER wiring rides the same gate position as the W1072.2
// operator hold (proven flush-level in fleet-loop-flush.test.ts).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	anyMergeDeferred,
	deferFileName,
	deferredBranches,
	enforceMergeDefers,
	mergeDeferredActive,
	readMergeDefer,
} from "../hooks/lib/fleet-loop/merge-defer.ts";
import { createRuntimeSync } from "../hooks/lib/fleet-loop/runtime-sync.ts";
import { writeStamp } from "../scripts/lib/auto-install.ts";

test.describe("@unit", () => {
	const worlds: ReturnType<typeof scratchWorld>[] = [];
	test.afterEach(() => {
		for (const w of worlds.splice(0)) w.clean();
	});
	const repo = (): string => {
		const w = scratchWorld({ prefix: "w2561-defer-" });
		worlds.push(w);
		return w.repo;
	};
	// the defer file name percent-encodes the namespaced branch
	const deferFile = (branch: string): string =>
		`${branch.replace(/%/g, "%25").replace(/\//g, "%2F")}.json`;
	const defer = (
		r: string,
		branch: string,
		over: Record<string, unknown> = {},
	): void => {
		mkdirSync(join(r, ".fleet/merge-defer"), { recursive: true });
		writeFileSync(
			join(r, ".fleet/merge-defer", deferFile(branch)),
			JSON.stringify({
				owner: "op",
				reason: "install window",
				expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
				...over,
			}),
		);
	};
	// enforcement writes events through openStore() — pin the store into the
	// scratch home so no NEED_DECISION ever reaches the live bus
	const withScratchStore = (home: string, fn: () => void): void => {
		const hadHome = process.env.HOME;
		const hadUrl = process.env.GOVERNOR_STORE_URL;
		process.env.HOME = home;
		process.env.GOVERNOR_STORE_URL = "local";
		try {
			fn();
		} finally {
			process.env.HOME = hadHome;
			process.env.GOVERNOR_STORE_URL = hadUrl;
		}
	};
	// hermetic maintenance gate (#102613, runtime-sync.test.ts pattern):
	// operations may flip the machine fleet_loop.maintenance to false (live
	// acceptance did); the runtimeSync test pins the documented env override
	// ON around its calls and restores the prior env either way.
	const withMaintenancePinned = (body: () => void): void => {
		const prev = process.env.SUSPENDERS_MAINTENANCE;
		process.env.SUSPENDERS_MAINTENANCE = "1";
		try {
			body();
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_MAINTENANCE;
			else process.env.SUSPENDERS_MAINTENANCE = prev;
		}
	};

	test("absent defer reads none / inactive; namespaced branch encodes flat", () => {
		const r = repo();
		expect(readMergeDefer(r, "suspenders/W9").state).toBe("none");
		expect(mergeDeferredActive(r, "suspenders/W9")).toBe(false);
		defer(r, "suspenders/W9");
		expect(mergeDeferredActive(r, "suspenders/W9")).toBe(true);
		// the encoded file name stays flat under the dir the scan reads
		expect(deferredBranches(r)).toEqual(["suspenders/W9"]);
		// another branch is never deferred by its sibling's file
		expect(mergeDeferredActive(r, "suspenders/W10")).toBe(false);
	});

	test("provenance contract: missing owner/reason, invalid or >7d expiresAt read malformed/inactive", () => {
		const r = repo();
		defer(r, "suspenders/W9", { owner: "" });
		expect(readMergeDefer(r, "suspenders/W9")).toMatchObject({
			state: "malformed",
			why: "missing owner",
		});
		defer(r, "suspenders/W9", { reason: "" });
		expect(readMergeDefer(r, "suspenders/W9")).toMatchObject({
			state: "malformed",
			why: "missing reason",
		});
		defer(r, "suspenders/W9", { expiresAt: "not-a-date" });
		expect(readMergeDefer(r, "suspenders/W9")).toMatchObject({
			state: "malformed",
			why: "missing or invalid expiresAt",
		});
		defer(r, "suspenders/W9", {
			expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString(),
		});
		expect(readMergeDefer(r, "suspenders/W9")).toMatchObject({
			state: "malformed",
			why: "expiresAt beyond the 7-day hold cap",
		});
		expect(mergeDeferredActive(r, "suspenders/W9")).toBe(false);
	});

	test("expired defer reads expired/inactive and ages out at enforcement: set aside, NEED_DECISION, branch resumes", () => {
		const w = worlds[worlds.length - 1] ?? scratchWorld({ prefix: "w2561-h-" });
		if (!worlds.includes(w)) worlds.push(w);
		const r = repo();
		defer(r, "suspenders/W9", {
			owner: "op2561",
			reason: "window that ended",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const view = readMergeDefer(r, "suspenders/W9");
		expect(view.state).toBe("expired");
		expect(mergeDeferredActive(r, "suspenders/W9")).toBe(false);
		const lines: string[] = [];
		withScratchStore(w.home, () => {
			enforceMergeDefers(r, (l) => lines.push(l));
			// the sync gate's own read ages it out identically
			expect(anyMergeDeferred(r)).toBe(false);
		});
		expect(lines[0]).toContain("DEFER-EXPIRED .fleet/merge-defer/");
		expect(lines[0]).toContain("owner=op2561");
		expect(mergeDeferredActive(r, "suspenders/W9")).toBe(false);
		expect(deferredBranches(r)).toEqual([]);
	});

	test("malformed defer is refused at enforcement: set aside as .rejected", () => {
		const w = worlds[worlds.length - 1] ?? scratchWorld({ prefix: "w2561-h-" });
		if (!worlds.includes(w)) worlds.push(w);
		const r = repo();
		mkdirSync(join(r, ".fleet/merge-defer"), { recursive: true });
		writeFileSync(
			join(r, ".fleet/merge-defer", deferFile("suspenders/W9")),
			"",
		);
		const lines: string[] = [];
		withScratchStore(w.home, () => {
			enforceMergeDefers(r, (l) => lines.push(l));
		});
		expect(lines[0]).toContain("DEFER-REJECTED .fleet/merge-defer/");
		expect(lines[0]).toContain("not valid JSON");
		expect(deferredBranches(r)).toEqual([]);
	});

	// the runtime-sync gate: an active defer defers the sweep without
	// spawning the runner (the #101230 mechanism — a held landing must not
	// publish+restart surfaces); expiry releases it.
	test("runtimeSync defers on an active merge defer and never spawns; expiry releases the sweep", () => {
		const r = repo();
		const stamps = join(r, "stamp.json");
		const lines: string[] = [];
		const deps = {
			REPO: r,
			MAIN: "main",
			log: (m: string) => lines.push(m),
			sh: (cmd: string[]) => (cmd[0] === "git" ? "bbb" : ""),
			run: () => 0,
			runCap: () => ({ code: 0, out: "" }),
			lanes: () => [],
			bumpFail: () => 1,
			clearFail: () => {},
			ahead: () => 0,
		};
		const { runtimeSync } = createRuntimeSync(deps, {
			statePath: stamps,
			spawn: () => {
				throw new Error("must not spawn under an active defer");
			},
		});
		writeStamp(stamps, "aaa");
		defer(r, "suspenders/W9");
		let first: ReturnType<typeof runtimeSync> | null = null;
		withMaintenancePinned(() => {
			first = runtimeSync();
		});
		expect(first).toEqual({
			ran: false,
			labels: [],
			reason: "merge-defer",
		});
		expect(lines).toContain("RUNTIME-SYNC-DEFER — active per-item merge defer");
		// expired: the gate's read ages it out and the sweep proceeds
		defer(r, "suspenders/W9", {
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		});
		let spawned = 0;
		const { runtimeSync: retry } = createRuntimeSync(deps, {
			statePath: stamps,
			spawn: () => {
				spawned++;
				return { code: 0, out: "" };
			},
		});
		withScratchStore(worlds[worlds.length - 1].home, () => {
			withMaintenancePinned(() => {
				expect(retry().ran).toBe(true);
			});
		});
		expect(spawned).toBe(1);
	});

	// W2580 (N3a, review #103237): the logged path IS the encoded on-disk
	// file name — an operator copying it never creates the nested directory
	// the readdir scan cannot see.
	test("deferFileName percent-encodes the namespaced branch the scan reads", () => {
		expect(deferFileName("suspenders/W2561")).toBe("suspenders%2FW2561.json");
		expect(deferFileName("a%b/c")).toBe("a%25b%2Fc.json");
		const r = repo();
		defer(r, "suspenders/W9");
		expect(
			existsSync(join(r, ".fleet/merge-defer", deferFileName("suspenders/W9"))),
		).toBe(true);
	});

	// W2580 (N3b): one bad-percent filename is quarantined aside (ONE
	// warning + NEED_DECISION, never per scan — root #103341: repeated
	// scans stay non-spamming), and the scan keeps gating every other
	// defer instead of silently returning [].
	test("a bad-percent defer filename is quarantined once; other defers keep scanning, repeated scans stay quiet", () => {
		const w = scratchWorld({ prefix: "w2580-badpct-" });
		worlds.push(w);
		const r = w.repo;
		defer(r, "suspenders/W9");
		writeFileSync(join(r, ".fleet/merge-defer", "bad%2ZZ.json"), "{}");
		const lines: string[] = [];
		withScratchStore(w.home, () => {
			expect(deferredBranches(r, (l) => lines.push(l))).toEqual([
				"suspenders/W9",
			]);
			expect(anyMergeDeferred(r, (l) => lines.push(l))).toBe(true);
		});
		expect(lines.filter((l) => l.includes("DEFER-UNREADABLE"))).toHaveLength(
			1,
		);
		expect(lines.some((l) => l.includes("bad%2ZZ.json"))).toBe(true);
		expect(
			existsSync(join(r, ".fleet/merge-defer", "bad%2ZZ.json.rejected")),
		).toBe(true);
		expect(deferredBranches(r, (l) => lines.push(l))).toEqual([
			"suspenders/W9",
		]);
	});
});
