// co-situated tests for the W459.5 identity registry lib: migration shape,
// fail-closed enrollment (idempotent same-source, cross-tenant refusal),
// checkout binding idempotency, the writes_enabled gate + identity.* events,
// provider-ref parsing and the 0600 binding/executor file IO. The registry
// functions are store-parametric — a bare :memory: Database with the events
// table (which openGovernorDb creates before the migration in production)
// stands in for the authority store; no HOME-pinned paths are touched except
// in the binding-IO block, which swaps process.env.HOME per test (the lib
// resolves HOME at call time).
import { Database } from "bun:sqlite";
import { test, expect } from "@playwright/test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	assertWritesEnabled,
	bindCheckout,
	bindingPath,
	ensureExecutorId,
	enrollRegistry,
	lookupCheckout,
	lookupProject,
	lookupRegisteredSource,
	migrateIdentityRegistry,
	parseRepoRef,
	readBinding,
	setWritesEnabled,
	writeBinding,
	writesEnabled,
	type IdentityBinding,
} from "./identity-registry.ts";

function authorityDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys=ON");
	// production order: openGovernorDb creates `events` before the v15 migration
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	migrateIdentityRegistry(db);
	return db;
}

const ENROLL = {
	tenant: "threads",
	provider: "github",
	providerRepoId: 42,
	canonicalUrl: "https://github.com/threads/fleet",
	displayName: "fleet",
	authorityUrl: null as string | null,
	source: "test",
};

function identityEvents(db: Database, kind: string): number {
	return (
		db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind) as {
			n: number;
		}
	).n;
}

test.describe("identity registry migration (v15)", () => {
	test("creates the four registry tables and sets user_version", () => {
		const db = authorityDb();
		const uv = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBe(15);
		for (const t of [
			"id_tenants",
			"id_projects",
			"id_repositories",
			"id_checkouts",
		])
			expect(
				db
					.query(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
					)
					.get(t),
			).toBeDefined();
	});

	test("is idempotent — re-running the migration over populated tables is a no-op", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		expect(r.created).toBe(true);
		migrateIdentityRegistry(db);
		expect(
			(db.query("SELECT COUNT(*) AS n FROM id_projects").get() as { n: number })
				.n,
		).toBe(1);
	});
});

test.describe("enrollment (G1)", () => {
	test("mints tenant/project/repository once, writes_enabled closed, event emitted", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		expect(r.created).toBe(true);
		expect(r.tenantId.startsWith("tnt_")).toBe(true);
		expect(r.projectId.startsWith("prj_")).toBe(true);
		expect(r.repositoryId.startsWith("rep_")).toBe(true);
		expect(r.writesEnabled).toBe(false);
		expect(identityEvents(db, "identity.enrolled")).toBe(1);
	});

	test("re-enrolling the same source is idempotent — SAME project_id, no second mint", () => {
		const db = authorityDb();
		const first = enrollRegistry(db, ENROLL);
		const second = enrollRegistry(db, ENROLL);
		expect(second.created).toBe(false);
		expect(second.projectId).toBe(first.projectId);
		expect(second.repositoryId).toBe(first.repositoryId);
		expect(
			(
				db.query("SELECT COUNT(*) AS n FROM id_repositories").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		expect(identityEvents(db, "identity.enrolled")).toBe(1);
	});

	test("the same source under a DIFFERENT tenant refuses", () => {
		const db = authorityDb();
		enrollRegistry(db, ENROLL);
		expect(() => enrollRegistry(db, { ...ENROLL, tenant: "other" })).toThrow(
			"different tenant",
		);
	});

	test("lookupRegisteredSource joins the full registry row", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		const row = lookupRegisteredSource(db, "github", 42);
		expect(row).not.toBeNull();
		expect(row?.project_id).toBe(r.projectId);
		expect(row?.tenant_name).toBe("threads");
		expect(row?.writes_enabled).toBe(0);
		expect(lookupRegisteredSource(db, "github", 999)).toBeNull();
	});

	test("lookupProject joins the tenant name and reports the gate state", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		const p = lookupProject(db, r.projectId);
		expect(p?.tenant_name).toBe("threads");
		expect(p?.writes_enabled).toBe(0);
		expect(lookupProject(db, "prj_nope")).toBeNull();
	});
});

test.describe("checkout binding (G2/G3)", () => {
	test("binds once per (repository, common dir); re-bind returns the same chk_", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		const b1 = bindCheckout(db, {
			repositoryId: r.repositoryId,
			projectId: r.projectId,
			tenantId: r.tenantId,
			executorId: "exe_a",
			commonGitDir: "/cloneA/.git",
		});
		expect(b1.created).toBe(true);
		expect(b1.checkoutId.startsWith("chk_")).toBe(true);
		const b2 = bindCheckout(db, {
			repositoryId: r.repositoryId,
			projectId: r.projectId,
			tenantId: r.tenantId,
			executorId: "exe_a",
			commonGitDir: "/cloneA/.git",
		});
		expect(b2.created).toBe(false);
		expect(b2.checkoutId).toBe(b1.checkoutId);
		expect(identityEvents(db, "identity.binding_set")).toBe(1);
		// a DIFFERENT clone (another common dir) gets its own checkout — G4's
		// distinct chk_A / chk_B
		const b3 = bindCheckout(db, {
			repositoryId: r.repositoryId,
			projectId: r.projectId,
			tenantId: r.tenantId,
			executorId: "exe_b",
			commonGitDir: "/cloneB/.git",
		});
		expect(b3.checkoutId).not.toBe(b1.checkoutId);
		expect(lookupCheckout(db, b1.checkoutId)?.common_git_dir).toBe(
			"/cloneA/.git",
		);
	});
});

test.describe("writes_enabled gate (G5)", () => {
	test("flip emits one event, keeps the epoch, no-op flip emits nothing", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		const epochBefore = (
			db
				.query("SELECT authority_epoch FROM id_projects WHERE project_id = ?")
				.get(r.projectId) as { authority_epoch: number }
		).authority_epoch;
		expect(setWritesEnabled(db, r.projectId, true, "test")).toBe(true);
		expect(writesEnabled(db, r.projectId)).toBe(true);
		const epochAfter = (
			db
				.query("SELECT authority_epoch FROM id_projects WHERE project_id = ?")
				.get(r.projectId) as { authority_epoch: number }
		).authority_epoch;
		expect(epochAfter).toBe(epochBefore);
		expect(identityEvents(db, "identity.writes_enabled")).toBe(1);
		// no-op: already enabled — no change, no event
		expect(setWritesEnabled(db, r.projectId, true, "test")).toBe(false);
		expect(identityEvents(db, "identity.writes_enabled")).toBe(1);
		// rollback = disable the one row
		expect(setWritesEnabled(db, r.projectId, false, "test")).toBe(true);
		expect(writesEnabled(db, r.projectId)).toBe(false);
	});

	test("unknown project refuses; gate throws + emits identity.denied while closed", () => {
		const db = authorityDb();
		const r = enrollRegistry(db, ENROLL);
		expect(writesEnabled(db, "prj_nope")).toBeNull();
		expect(() => setWritesEnabled(db, "prj_nope", true, "test")).toThrow(
			"unknown enrolled project",
		);
		expect(() => assertWritesEnabled(db, r.projectId)).toThrow("DISABLED");
		expect(identityEvents(db, "identity.denied")).toBe(1);
		setWritesEnabled(db, r.projectId, true, "test");
		expect(() => assertWritesEnabled(db, r.projectId)).not.toThrow();
	});
});

test.describe("provider reference parsing", () => {
	test("URL, ssh and scp spellings collapse to the owner/name slug", () => {
		expect(parseRepoRef("https://github.com/threads/fleet.git")).toBe(
			"threads/fleet",
		);
		expect(parseRepoRef("git@github.com:threads/fleet.git")).toBe(
			"threads/fleet",
		);
		expect(parseRepoRef("ssh://git@github.com/threads/fleet")).toBe(
			"threads/fleet",
		);
		expect(parseRepoRef("threads/fleet")).toBe("threads/fleet");
		expect(() => parseRepoRef("not-a-repo-ref")).toThrow();
	});
});

test.describe("local binding + executor identity (machine config)", () => {
	test("executor id mints once per machine and survives re-reads", () => {
		const home = mkdtempSync(`${tmpdir()}/idreg-`);
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const a = ensureExecutorId();
			expect(a.startsWith("exe_")).toBe(true);
			expect(ensureExecutorId()).toBe(a);
			const stat = statSync(`${home}/.config/klh/identity/executor.json`);
			expect(stat.mode & 0o777).toBe(0o600);
		} finally {
			process.env.HOME = prevHome;
		}
	});

	test("binding file round-trips at 0600; garbage reads as null", () => {
		const home = mkdtempSync(`${tmpdir()}/idreg-`);
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			expect(readBinding()).toBeNull();
			const b: IdentityBinding = {
				schema: 1,
				tenant_id: "tnt_x",
				project_id: "prj_x",
				repository_id: "rep_x",
				executor_id: "exe_x",
				checkout_id: "chk_x",
				authority: { url: "http://127.0.0.1:7794", epoch: 1 },
				local: {
					repo_root: "/repo",
					common_git_dir: "/repo/.git",
					resolved_at: 123,
				},
				verified: {
					provider: "github",
					provider_repo_id: 42,
					verified_at: 123,
					verified_by: "enrollment-v1",
				},
			};
			writeBinding(b);
			const stat = statSync(bindingPath());
			expect(stat.mode & 0o777).toBe(0o600);
			expect(readBinding()).toEqual(b);
		} finally {
			process.env.HOME = prevHome;
		}
	});
});
