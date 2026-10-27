// deploy/hub-catalog.e2e.ts — W1711 proof for hub catalog reconciliation
// (hub-catalog.ts + the hub-catalog-sync CLI). Catalogs come from in-process
// mock fetchers and every stack is a 0600 fixture under the OS tmpdir — no
// network, no machine stack, no real credential. Shape law (tests/
// check-deps.e2e.ts): the spec carries ONLY imports and test registrations;
// helpers live in ./hub-catalog-fixture.ts. Tagged @unit (agent-rules/
// test.agent.md): provider HTTP is mocked at the fetch seam. Run:
//   bun --cwd packages/suspenders playwright test --config deploy/playwright.config.ts
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { COPILOT_CATALOG_URL } from "@klh/belt/bin/model-capabilities.ts";
import {
	applyCatalogPlan,
	CatalogConflict,
	checkHubCatalog,
} from "./hub-catalog.ts";
import {
	CATALOG_ROWS,
	catalogFetcher,
	dropFixture,
	duplicateFirst,
	fileMode,
	filesContaining,
	holdLock,
	KEY_VALUE,
	listDir,
	loosenKey,
	makeFixture,
	models,
	ops,
	PROVIDER_FAILURES,
	planWith,
	readText,
	reportOf,
	retarget,
	rowAt,
	runSyncCli,
	snapshotWire,
	stackBytes,
	stripFlags,
	touchStack,
	verdicts,
	withOp,
	writePlan,
} from "./hub-catalog-fixture.ts";

test.describe("hub catalog reconciliation", { tag: "@unit" }, () => {
	test("dry run: one authenticated listing, per-row verdicts, nothing written", async () => {
		const f = makeFixture();
		try {
			const before = stackBytes(f);
			const mock = catalogFetcher();
			const result = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: mock.fetcher });
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.url).toBe(COPILOT_CATALOG_URL);
			expect(mock.calls[0]?.headers.authorization).toBe(`Bearer ${KEY_VALUE}`);
			expect(mock.calls[0]?.headers["copilot-integration-id"]).toBe("vscode-chat");
			expect(mock.calls[0]?.headers["anthropic-beta"]).toBeUndefined();
			expect(verdicts(result.reports)).toEqual({
				"claude-sonnet-5[0]": "present supported",
				"gpt-6.1-sol[0]": "present supported",
				"grok-4.7[0]": "present unsupported",
				"claude-old[0]": "stale unknown",
				"claude-old[1]": "no-catalog unknown",
				"gpt-legacy[0]": "stale unknown",
				"local[0]": "no-catalog unknown",
				"unkeyed[0]": "no-credential unknown",
			});
			expect(ops(result.plan)).toEqual(["flag claude-old[0]", "flag gpt-legacy[0]"]);
			expect(result.plan.capabilities).toHaveLength(3);
			expect(stackBytes(f)).toBe(before);
			expect(listDir(f)).toEqual(["copilot.key", "stack.json"]);
			expect(JSON.stringify(result)).not.toContain(KEY_VALUE);
			expect(JSON.stringify(result)).not.toContain(f.keyFile);
		} finally {
			dropFixture(f);
		}
	});

	test("revoked credential: 401/403 is a credential verdict, never a stale row", async () => {
		const f = makeFixture();
		try {
			for (const status of [401, 403]) {
				const mock = catalogFetcher(status);
				const result = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: mock.fetcher });
				expect(reportOf(result.reports, "claude-old")?.verdict).toBe("credential-rejected");
				expect(reportOf(result.reports, "claude-old")?.detail).toBe(`HTTP ${status}`);
				expect(verdicts(result.reports)["claude-sonnet-5[0]"]).toBe("credential-rejected unknown");
				expect(result.plan.actions).toEqual([]);
				expect(result.plan.capabilities).toEqual([]);
				expect(JSON.stringify(result)).not.toContain(KEY_VALUE);
			}
		} finally {
			dropFixture(f);
		}
	});

	test("provider failure: fixed detail text, no stale verdicts, no actions", async () => {
		const f = makeFixture();
		try {
			for (const failure of PROVIDER_FAILURES) {
				const mock = catalogFetcher(failure.reply);
				const result = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: mock.fetcher });
				expect(reportOf(result.reports, "claude-old")?.verdict).toBe("provider-failure");
				expect(reportOf(result.reports, "claude-old")?.detail).toBe(failure.detail);
				expect(verdicts(result.reports)["gpt-legacy[0]"]).toBe("provider-failure unknown");
				expect(result.plan.actions).toEqual([]);
				expect(JSON.stringify(result)).not.toContain(KEY_VALUE);
			}
		} finally {
			dropFixture(f);
		}
	});

	test("credential missing: a loose key file is refused before any request", async () => {
		const f = makeFixture();
		try {
			loosenKey(f);
			const mock = catalogFetcher();
			const result = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: mock.fetcher });
			expect(mock.calls).toHaveLength(0);
			expect(reportOf(result.reports, "claude-sonnet-5")?.verdict).toBe("credential-missing");
			expect(reportOf(result.reports, "claude-sonnet-5")?.detail).toBe("key file missing, empty or not 0600");
			expect(result.plan.actions).toEqual([]);
		} finally {
			dropFixture(f);
		}
	});

	test("remote hub: keys stay on the device, so rows are unverifiable and unfetched", async () => {
		const f = makeFixture();
		try {
			const mock = catalogFetcher();
			const result = await checkHubCatalog({ hub: "nas", stackPath: f.stackPath, fetcher: mock.fetcher });
			expect(mock.calls).toHaveLength(0);
			expect(verdicts(result.reports)).toEqual({ "claude-sonnet-5[0]": "credential-on-device unknown" });
			expect(result.plan.actions).toEqual([]);
			await expect(checkHubCatalog({ hub: "nope", stackPath: f.stackPath, fetcher: mock.fetcher })).rejects.toThrow("unknown hub nope");
		} finally {
			dropFixture(f);
		}
	});

	test("stale rows: apply flags them in place, keeps betas and groups, persists capabilities", async () => {
		const f = makeFixture();
		try {
			const before = stackBytes(f);
			const checked = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			const result = await applyCatalogPlan({ plan: checked.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath });
			expect(result.changed).toBe(true);
			expect(result.actions).toBe(2);
			expect(result.capabilities).toBe(3);
			expect(rowAt(f, "claude-old", 0)?.model).toBe("claude-old-4");
			expect(rowAt(f, "claude-old", 0)?.catalog_stale).toEqual({ source: COPILOT_CATALOG_URL, observed_at: expect.any(String) });
			expect(rowAt(f, "gpt-legacy", 0)?.catalog_stale).toBeTruthy();
			expect(rowAt(f, "claude-sonnet-5", 0)?.catalog_stale).toBeUndefined();
			expect(stripFlags(stackBytes(f))).toEqual(stripFlags(before));
			expect(stackBytes(f)).not.toContain("claude-old-4.1");
			expect(readText(String(result.backup))).toBe(before);
			expect(fileMode(String(result.backup))).toBe(0o600);
			expect(fileMode(f.stackPath)).toBe(0o600);
			expect(fileMode(f.capabilitiesPath)).toBe(0o600);
			const sonnet = await snapshotWire(f, "claude-sonnet-5");
			expect(sonnet.state).toBe("available");
			expect(sonnet.wire).toEqual(["/v1/messages", "/v1/chat/completions"]);
			expect((await snapshotWire(f, "gpt-6.1-sol")).wire).toEqual(["/v1/responses"]);
			expect((await snapshotWire(f, "claude-old")).wire).toBeNull();
			expect(filesContaining(f, KEY_VALUE)).toEqual(["copilot.key"]);
		} finally {
			dropFixture(f);
		}
	});

	test("re-listed row: the flag clears; a still-stale flagged row gets no action", async () => {
		const f = makeFixture();
		try {
			const first = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			await applyCatalogPlan({ plan: first.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath });
			const relisted = catalogFetcher("ok", CATALOG_ROWS.concat([{ id: "claude-old-4" }]));
			const second = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: relisted.fetcher });
			expect(reportOf(second.reports, "claude-old")?.flagged).toBe(true);
			expect(reportOf(second.reports, "gpt-legacy")?.flagged).toBe(true);
			expect(ops(second.plan)).toEqual(["unflag claude-old[0]"]);
			const result = await applyCatalogPlan({ plan: second.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath });
			expect(result.changed).toBe(true);
			expect(rowAt(f, "claude-old", 0)?.catalog_stale).toBeUndefined();
			expect(rowAt(f, "gpt-legacy", 0)?.catalog_stale).toBeTruthy();
			const settled = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: relisted.fetcher });
			expect(settled.plan.actions).toEqual([]);
			const idle = await applyCatalogPlan({ plan: settled.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath });
			expect(idle.changed).toBe(false);
			expect(idle.backup).toBeNull();
		} finally {
			dropFixture(f);
		}
	});

	test("--remove-stale: removes only when the group keeps a row, never substitutes", async () => {
		const f = makeFixture();
		try {
			const checked = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, removeStale: true, fetcher: catalogFetcher().fetcher });
			expect(ops(checked.plan)).toEqual(["remove claude-old[0]", "flag gpt-legacy[0]"]);
			const result = await applyCatalogPlan({ plan: checked.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath });
			expect(result.actions).toBe(2);
			expect(models(f, "claude-old")).toEqual(["local-reason"]);
			expect(models(f, "gpt-legacy")).toEqual(["gpt-4.9-legacy"]);
			expect(rowAt(f, "gpt-legacy", 0)?.catalog_stale).toBeTruthy();
			expect(models(f, "local")).toEqual(["local-reason"]);
			expect(stackBytes(f)).not.toContain("claude-old-4.1");
			expect(stackBytes(f)).not.toContain("gpt-4.9-legacy-preview");
		} finally {
			dropFixture(f);
		}
	});

	test("conflicting write: an edited or locked stack refuses with nothing written", async () => {
		const f = makeFixture();
		try {
			const checked = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			const edited = touchStack(f);
			const moved = await applyCatalogPlan({ plan: checked.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath }).catch((error) => error);
			expect(moved).toBeInstanceOf(CatalogConflict);
			expect(moved.message).toContain("stack changed since check");
			expect(stackBytes(f)).toBe(edited);
			expect(listDir(f)).toEqual(["copilot.key", "stack.json"]);
			const fresh = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			holdLock(f);
			const locked = await applyCatalogPlan({ plan: fresh.plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath }).catch((error) => error);
			expect(locked).toBeInstanceOf(CatalogConflict);
			expect(locked.message).toContain("stack lock is held by another writer");
			expect(stackBytes(f)).toBe(edited);
		} finally {
			dropFixture(f);
		}
	});

	test("plan binding: foreign, expired, duplicate, malformed or drifted plans write nothing", async () => {
		const f = makeFixture();
		try {
			const before = stackBytes(f);
			const checked = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			const plan = checked.plan;
			await expect(applyCatalogPlan({ plan: planWith(plan, "stack_path", join(f.dir, "other.json")), stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath })).rejects.toThrow("made for another stack file");
			await expect(applyCatalogPlan({ plan, stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath, now: Date.now() + 25 * 3_600_000 })).rejects.toThrow("older than 24h");
			await expect(applyCatalogPlan({ plan: duplicateFirst(plan), stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath })).rejects.toThrow("names a row twice");
			await expect(applyCatalogPlan({ plan: planWith(plan, "capabilities", [{ provider: "copilot" }]), stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath })).rejects.toThrow("malformed");
			await expect(applyCatalogPlan({ plan: retarget(plan, "claude-old", "claude-old-4.1"), stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath })).rejects.toThrow("plan row claude-old[0] does not match the stack");
			await expect(applyCatalogPlan({ plan: withOp(plan, "gpt-legacy", "remove"), stackPath: f.stackPath, capabilitiesPath: f.capabilitiesPath })).rejects.toThrow("would empty group gpt-legacy");
			expect(stackBytes(f)).toBe(before);
			expect(listDir(f)).toEqual(["copilot.key", "stack.json"]);
		} finally {
			dropFixture(f);
		}
	});

	test("CLI: check prints verdicts and counts only; apply lands a reviewed plan once", async () => {
		const f = makeFixture();
		try {
			const planOut = join(f.dir, "nas-plan.json");
			const check = runSyncCli(f, ["check", "--hub", "nas", "--plan-out", planOut]);
			expect(check.status).toBe(0);
			expect(check.out).toContain("claude-sonnet-5[0] claude-sonnet-5.5 credential-on-device wire=unknown");
			expect(check.out).toContain("1 rows (credential-on-device=1); 0 actions; 0 capability records");
			expect(check.out).toContain("plan written 0600");
			expect(fileMode(planOut)).toBe(0o600);
			expect(check.out).not.toContain(KEY_VALUE);
			expect(check.out).not.toContain(f.keyFile);
			const clobber = runSyncCli(f, ["check", "--hub", "desk", "--plan-out", f.stackPath]);
			expect(clobber.status).toBe(1);
			expect(clobber.out).toContain("--plan-out must not name the stack file");
			const checked = await checkHubCatalog({ hub: "desk", stackPath: f.stackPath, fetcher: catalogFetcher().fetcher });
			const planPath = writePlan(f, checked.plan);
			const applied = runSyncCli(f, ["apply", "--plan", planPath]);
			expect(applied.status).toBe(0);
			expect(applied.out).toContain("applied: 2 stack actions, 3 capability records");
			expect(applied.out).not.toContain(KEY_VALUE);
			expect((await snapshotWire(f, "gpt-6.1-sol")).wire).toEqual(["/v1/responses"]);
			const replay = runSyncCli(f, ["apply", "--plan", planPath]);
			expect(replay.status).toBe(3);
			expect(replay.out).toContain("stack changed since check; nothing written");
		} finally {
			dropFixture(f);
		}
	});
});
