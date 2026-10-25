// govdb-surface.test.ts — W624: govdb.ts is now a re-export entrypoint over
// the govdb-* sibling modules. 100+ consumers import the named surface from
// govdb.ts; this file pins that facade: every public symbol stays importable,
// same identity, and a fresh openGovernorDb still migrates + serves the
// re-exported helpers. Behavior suites (migration, split, store, sessions)
// cover the semantics; this covers the CONTRACT.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GovernorStatement,
	GovernorStore,
	ItemTiming,
	ItemTokens,
	ResolvedProject,
	StoreResult,
} from "../hooks/lib/govdb/govdb.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-surface-"));
// restore before afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // govdb computes REG from HOME at module load — set before the dynamic import
// ?query busts bun's module cache (shared registry across test files) so this
// file's instance binds to the temp HOME, never the production DB.
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
// file-scope env restore — the rest of the suite shares this process (W1124.11)
afterAll(() => {
	process.env.HOME = REAL_HOME;
});

const VALUE_SYMBOLS = [
	"projectIdentity",
	"projectRootOf",
	"resolveProject",
	"CAPABILITIES",
	"isDecisionKind",
	"workTiming",
	"tokenUsage",
	"migrateKnowledgeSplit",
	"openGovernorDb",
	"openKnowledgeDb",
	"pruneDeltas",
	"HttpGovernorStore",
	"knowledgeSqlViolation",
	"identitySqlViolation",
	"migrateIdentitySplit",
	"openIdentityDb",
	"openIdentity",
	"openMemoryStore",
	"openStore",
	"resolveStoreHttpBase",
	"sweepStaleSessions",
	"tagNameOf",
] as const;

describe("govdb entrypoint surface (W624 facade)", () => {
	test("every public value symbol re-exports defined", () => {
		for (const name of VALUE_SYMBOLS)
			expect(govdb, `govdb.${name}`).toHaveProperty(name);
		for (const name of VALUE_SYMBOLS) {
			const v = (govdb as Record<string, unknown>)[name];
			expect(v, `govdb.${name} defined`).toBeDefined();
		}
	});

	test("function-typed symbols are functions", () => {
		const fns = VALUE_SYMBOLS.filter((s) => s !== "CAPABILITIES");
		for (const name of fns)
			expect(
				typeof (govdb as Record<string, unknown>)[name],
				`typeof govdb.${name}`,
			).toBe("function");
	});

	test("CAPABILITIES vocabulary unchanged", () => {
		expect(govdb.CAPABILITIES).toEqual([
			"shell",
			"fs",
			"git",
			"build",
			"mcp",
			"vision",
			"browser",
			"network",
		]);
	});

	test("isDecisionKind W54 normalization intact", () => {
		expect(govdb.isDecisionKind("NEED_DECISION")).toBe(true);
		expect(govdb.isDecisionKind("need-decision")).toBe(true); // W54: uppercase-only gate admits the shipped-lane form
		expect(govdb.isDecisionKind("broadcast")).toBe(false);
		expect(govdb.isDecisionKind("")).toBe(false);
	});

	test("openGovernorDb migrates a fresh REG and serves the helpers", () => {
		const db = govdb.openGovernorDb();
		const uv = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBeGreaterThanOrEqual(19); // durable work spend histogram
		db.query(
			"INSERT INTO work_spend_histogram (project,work_id,bucket_ms,fresh,cached,out_tok) VALUES ('p','W1',1000,10,20,3)",
		).run();
		// re-exported helpers operate on the real handle
		expect(govdb.tagNameOf('{"name":"autow624"}')).toBe("autow624"); // W293 tags-JSON bridge
		expect(govdb.tagNameOf("autow624-p98b319584008df14")).toBeNull(); // malformed tags → null, never throws
		expect(() => govdb.pruneDeltas(db, 100)).not.toThrow();
		expect(() => govdb.sweepStaleSessions(db, 60_000)).not.toThrow();
		db.close();
		const reopened = govdb.openGovernorDb();
		expect(
			reopened
				.query(
					"SELECT fresh,cached,out_tok FROM work_spend_histogram WHERE project='p' AND work_id='W1'",
				)
				.get(),
		).toEqual({ fresh: 10, cached: 20, out_tok: 3 });
		reopened.close();
	});

	test("openKnowledgeDb opens the split file with the checkpoint table", () => {
		const kb = govdb.openKnowledgeDb();
		const row = kb
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_checkpoint'",
			)
			.get();
		expect(row).not.toBeNull();
		kb.close();
	});

	test("type-only surface resolves (compile-level contract)", () => {
		// type positions must typecheck against the re-exported interfaces
		const t: Pick<ResolvedProject, "id" | "root"> = { id: "x", root: "y" };
		const stmt: GovernorStatement | undefined = undefined;
		const store: GovernorStore | null = null;
		const res: StoreResult | null = null;
		const it: ItemTiming | null = null;
		const tk: ItemTokens | null = null;
		expect([t.id, stmt, store, res, it, tk]).toEqual([
			"x",
			undefined,
			null,
			null,
			null,
			null,
		]);
	});

	afterAll(() => {
		rmSync(HOME, { recursive: true, force: true });
	});
});
