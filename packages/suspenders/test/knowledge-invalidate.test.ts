// test/knowledge-invalidate.test.ts — W1228 landing invalidation: planner
// rules, apply markers, finding promotion, the facade (diff + fail-open),
// and the gc --forget CLI face. HOME is a temp dir set BEFORE the dynamic
// imports (the retention.test.ts pattern — govdb binds REG at module load).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(process.cwd(), ".w1228-home-"));
process.env.HOME = HOME;

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

const govdb = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const inv = await import("../hooks/lib/knowledge-invalidate.ts");
const conf = await import("../hooks/lib/confidence.ts");

const gov = govdb.openGovernorDb();
const kb = govdb.openKnowledgeDb();
const DAY = 86_400_000;

const seedKnowledge = (
	fact: string,
	opts: { source_ref?: string | null; area?: string | null } = {},
): number => {
	const r = kb
		.query(
			"INSERT INTO knowledge (ts, topic, fact, source_ref, area, state) VALUES (?, ?, ?, ?, ?, 'candidate')",
		)
		.run(Date.now(), "topic", fact, opts.source_ref ?? null, opts.area ?? null);
	return Number(r.lastInsertRowid);
};

const seedFact = (key: string, value: string, ts = Date.now()): void => {
	gov
		.query("INSERT INTO facts (key, value, source, ts) VALUES (?, ?, ?, ?)")
		.run(key, value, "test", ts);
};

const mkRepo = (): { dir: string; base: string; sha: string } => {
	// OUTSIDE every git work tree — a dir inside the worktree resolves git -C
	// upward to THIS repo (stray commits + the 30s pre-commit test suite)
	const dir = mkdtempSync(join(tmpdir(), "w1228-repo-"));
	const git = (args: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", dir, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return new TextDecoder().decode(p.stdout).trim();
	};
	git(["init", "-q"]);
	writeFileSync(join(dir, "a.md"), "hello\n");
	git(["add", "."]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
	const base = git(["rev-parse", "HEAD"]);
	writeFileSync(join(dir, "b.md"), "world\n");
	git(["add", "."]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "land"]);
	return { dir, base, sha: git(["rev-parse", "HEAD"]) };
};

describe("w1228 knowledge invalidation", () => {
	test("touchedAreas: parent dirs only, deduped", () => {
		expect(
			inv.touchedAreas(["hooks/lib/a.ts", "hooks/lib/b.ts", "x.md"]),
		).toEqual(["hooks/lib"]);
	});

	test("planner: source_ref, then area, then text — first hit wins", () => {
		const plan = inv.planKnowledgeInvalidation(
			[
				{ id: 1, source_ref: "docs/x.md", area: null, fact: null },
				{ id: 2, source_ref: null, area: "docs", fact: null },
				{ id: 3, source_ref: "other/y.ts", area: null, fact: "see docs/x.md" },
				{ id: 4, source_ref: null, area: null, fact: "unrelated" },
			],
			[{ key: "lesson.p", value: "the ladder lives in docs/x.md now" }],
			{ files: ["docs/x.md"], via: "merge" },
		);
		expect(plan.knowledge.map((m) => m.id)).toEqual([1, 2, 3]);
		expect(plan.knowledge[0]?.why).toBe("source_ref docs/x.md");
		expect(plan.knowledge[1]?.why).toBe("area docs");
		expect(plan.knowledge[2]?.why).toBe("text docs/x.md");
		expect(plan.facts).toEqual([
			{ id: 0, why: "text docs/x.md", key: "lesson.p" },
		]);
	});

	test("apply: stale markers on both stores + one knowledge.stale event", () => {
		const id = seedKnowledge("pointer to b.md", { source_ref: "b.md" });
		seedFact("lesson.f", "names b.md too");
		const touched = {
			files: ["b.md"],
			item: "W9",
			sha: "abc123def456",
			via: "work.done",
		} as const;
		const plan = inv.planKnowledgeInvalidation(
			[{ id, source_ref: "b.md", area: null, fact: "pointer to b.md" }],
			[{ key: "lesson.f", value: "names b.md too" }],
			touched,
		);
		const counts = inv.applyKnowledgeInvalidation({ gov, kb }, plan, touched);
		expect(counts).toEqual({ knowledge: 1, facts: 1 });
		const row = kb
			.query(
				"SELECT stale_at, stale_reason, contributors FROM knowledge WHERE id = ?",
			)
			.get(id) as {
			stale_at: number | null;
			stale_reason: string | null;
			contributors: string | null;
		};
		expect(row.stale_at).toBeGreaterThan(0);
		expect(row.stale_reason).toBe(
			"work.done W9 @ abc123def456 touched (source_ref b.md)",
		);
		const notes = JSON.parse(row.contributors ?? "[]") as { sid: string }[];
		expect(notes.at(-1)?.sid).toBe("stale-for-review");
		const frow = gov
			.query("SELECT stale_at, stale_reason FROM facts WHERE key = 'lesson.f'")
			.get() as { stale_at: number | null; stale_reason: string | null };
		expect(frow.stale_at).toBeGreaterThan(0);
		const ev = gov
			.query(
				"SELECT payload FROM events WHERE kind = 'knowledge.stale' ORDER BY ts DESC",
			)
			.get() as { payload: string } | null;
		expect(ev).not.toBeNull();
		const payload = JSON.parse(ev?.payload ?? "{}") as {
			item: string | null;
			knowledge: number[];
			facts: string[];
		};
		expect(payload.item).toBe("W9");
		expect(payload.knowledge).toContain(id);
		expect(payload.facts).toContain("lesson.f");
	});

	test("promotion: exact/prefix/case-insensitive, dot-anchored, never a downgrade", () => {
		seedFact("finding.w50", "branch-local finding");
		seedFact("finding.W50.2", "child finding");
		seedFact("finding.w5099", "dot-anchored: must NOT match");
		seedFact("finding.w50.strong", "already proven at 0.7");
		const stamp070 = conf.makeStamp({
			value: 0.7,
			setter: "mechanical:test",
			evidence: "seeded strong",
		});
		gov
			.query(
				"UPDATE facts SET confidence = ?, confidence_stamp = ? WHERE key = 'finding.w50.strong'",
			)
			.run(stamp070.value, JSON.stringify(stamp070));
		const { promoted } = inv.promoteLandedFindings(gov, "W50", "deadbeefcafe");
		expect(promoted.sort()).toEqual(["finding.W50.2", "finding.w50"]);
		const strong = gov
			.query("SELECT confidence FROM facts WHERE key = 'finding.w50.strong'")
			.get() as { confidence: number | null };
		expect(strong.confidence).toBe(0.7);
		const led = gov
			.query(
				"SELECT COUNT(*) AS n FROM confidence_history WHERE row_key IN ('finding.w50', 'finding.W50.2')",
			)
			.get() as { n: number };
		expect(led.n).toBe(2);
	});

	test("facade: no files → null no-op, no event", () => {
		const count = (): number =>
			(
				gov
					.query(
						"SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge.stale'",
					)
					.get() as { n: number }
			).n;
		const before = count();
		const r = inv.invalidateForLanding({
			repo: HOME,
			item: "W1",
			sha: null,
			files: [],
			via: "work.done",
			gov,
			kb,
		});
		expect(r).toBeNull();
		expect(count()).toBe(before);
	});

	test("facade: diffs base..sha, flags matching rows, promotes the finding", () => {
		kb.query(
			"UPDATE knowledge SET state = 'retired' WHERE state != 'retired'",
		).run();
		const repo = mkRepo();
		const id = seedKnowledge("b.md is the contract", { source_ref: "b.md" });
		seedFact("finding.w1", "lane-local");
		const r = inv.invalidateForLanding({
			repo: repo.dir,
			item: "W1",
			sha: repo.sha,
			base: repo.base,
			via: "work.done",
			gov,
			kb,
		});
		// facts: 1 = the apply test's lesson.f ("names b.md too") — still
		// candidate-state and legitimately matched by the same facade run
		expect(r).toEqual({ knowledge: 1, facts: 1, promoted: ["finding.w1"] });
		const row = kb
			.query("SELECT stale_at FROM knowledge WHERE id = ?")
			.get(id) as { stale_at: number | null };
		expect(row.stale_at).toBeGreaterThan(0);
	});

	test("facade: git trouble → null (fail-open)", () => {
		const r = inv.invalidateForLanding({
			repo: join(HOME, "no-such-repo"),
			item: "W2",
			sha: "abc",
			via: "merge",
			gov,
			kb,
		});
		expect(r).toBeNull();
	});

	test("gc --forget: age-scoped namespace forget, machine cursors refused", async () => {
		seedFact("lesson.old", "stale lesson", Date.now() - 5 * DAY);
		seedFact("lesson.new", "fresh lesson", Date.now());
		const coordPath = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
		const run = async (args: string[]): Promise<number> => {
			const proc = Bun.spawn([process.execPath, coordPath, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				// lane shells carry GOVERNOR_STORE_URL → a bare child rides the
				// REAL fleet store; pin in-process SQLite at the temp HOME
				env: { ...process.env, GOVERNOR_STORE_URL: "local" },
			});
			await proc.exited;
			return proc.exitCode ?? 1;
		};
		expect(await run(["gc", "--forget", "lesson.:1"])).toBe(0);
		const gone = gov
			.query("SELECT value FROM facts WHERE key = 'lesson.old'")
			.get();
		expect(gone).toBeNull();
		const kept = gov
			.query("SELECT value FROM facts WHERE key = 'lesson.new'")
			.get();
		expect(kept).not.toBeNull();
		expect(await run(["gc", "--forget", "activity.tp.:1"])).toBe(2);
	}, 30000);
});
