// test/fact-provenance.test.ts — W1226: the fact provenance schema.
// Covers: the coord fact set/get round-trip through a REAL coord subprocess
// (temp HOME, temp git repo as the session's worktree — attribution derives
// from the session record, never flags), the record parser's strictness
// (unknown keys drop, strings clamp), the redact-before-remote pass in
// collectFacts (W236 rules over value + provenance; secrets skip the row),
// and the hub landing (provenance stored on the knowledge row, builtin-rule
// re-scrub, strict prov validation). coord-fact-cas.test.ts CLI recipe.
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_PROV_FIELD,
	collectFacts,
	parseProvenance,
	type SyncState,
} from "../hooks/lib/knowledge/knowledge-sync.ts";
import { landKnowledgeIngest } from "../hooks/board/knowledge-ingest.ts";

test.setTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");

// ─── CLI harness: temp HOME + temp git repo ─────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "w1226-cli-"));
const repo = join(home, "repo");
mkdirSync(repo, { recursive: true });
const git = (args: string[]): void => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: home },
	});
	if (p.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`,
		);
};
git(["init", "-b", "main"]);
git(["config", "user.email", "w1226@test"]);
git(["config", "user.name", "w1226"]);
git(["commit", "--allow-empty", "-m", "seed"]);

const runCli = (
	args: string[],
	cwd = repo,
): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], {
		cwd,
		env: {
			...process.env,
			HOME: home,
			SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

test.afterAll(() => rmSync(home, { recursive: true, force: true }));

// ─── coord CLI round-trip: session-derived attribution ──────────────────────

test.describe("W1226 fact provenance — coord CLI round-trip", () => {
	test("set with evidence flags + --as: attribution derives from the session record", () => {
		const b = runCli(["bootstrap", "--as", "s1", "--worktree", repo]);
		expect(b.code).toBe(0);
		const r = runCli([
			"fact",
			"set",
			"w1226.evidence",
			"the gate denies past-1500 writes",
			"--trigger",
			"third write to a growing file",
			"--verification",
			"hooks/gates/files.ts:40",
			"--source-commit",
			"7460585",
			"--applicability",
			"fleet lanes editing near the 1500 cap",
			"--as",
			"s1",
		]);
		expect(r.code).toBe(0);
		const g = runCli(["fact", "get", "w1226.evidence"]);
		expect(g.out).toContain("the gate denies past-1500 writes");
		expect(g.out).toContain("· trigger: third write to a growing file");
		expect(g.out).toContain("· verification: hooks/gates/files.ts:40");
		expect(g.out).toContain("· source_commit: 7460585");
		// session-derived: repo@branch from the session's worktree, session sid
		// (bootstrap canonicalizes the worktree — macOS /var → /private/var)
		expect(g.out).toContain(`· attribution: ${realpathSync(repo)}@main`);
		expect(g.out).toContain("session s1");
	});

	test("--source-commit refuses non-sha evidence", () => {
		const r = runCli([
			"fact",
			"set",
			"w1226.badsha",
			"v",
			"--source-commit",
			"not-a-sha",
			"--as",
			"s1",
		]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("7-40 hex");
	});

	test("overwrite without evidence flags drops stale evidence", () => {
		expect(
			runCli([
				"fact",
				"set",
				"w1226.stale",
				"v1",
				"--trigger",
				"t1",
				"--as",
				"s1",
			]).code,
		).toBe(0);
		expect(runCli(["fact", "set", "w1226.stale", "v2"]).code).toBe(0);
		const g = runCli(["fact", "get", "w1226.stale"]);
		expect(g.out).toContain("v2");
		expect(g.out).not.toContain("t1");
		expect(g.out).not.toContain("attribution");
	});

	test("no --as: flags land, no attribution line", () => {
		const r = runCli([
			"fact",
			"set",
			"w1226.noattr",
			"v",
			"--trigger",
			"t",
			"--verification",
			"f:1",
		]);
		expect(r.code).toBe(0);
		const g = runCli(["fact", "get", "w1226.noattr"]);
		expect(g.out).toContain("· trigger: t");
		expect(g.out).not.toContain("attribution");
	});

	test("usage text names the provenance flags", () => {
		const h = runCli(["fact", "set"]);
		expect(`${h.err}${h.out}`).toContain("--source-commit");
	});

	test("--source <registered sid> also mints attribution (landing-chain flow)", () => {
		const r = runCli([
			"fact",
			"set",
			"w1226.viasource",
			"v",
			"--trigger",
			"t",
			"--source",
			"s1",
		]);
		expect(r.code).toBe(0);
		const g = runCli(["fact", "get", "w1226.viasource"]);
		expect(g.out).toContain("· attribution: ");
		expect(g.out).toContain("session s1");
		// a typed sid with no registered session mints nothing
		const fake = runCli([
			"fact",
			"set",
			"w1226.fakesid",
			"v",
			"--source",
			"not-a-session",
		]);
		expect(fake.code).toBe(0);
		const fg = runCli(["fact", "get", "w1226.fakesid"]);
		expect(fg.out).not.toContain("attribution");
	});
});

// ─── parser strictness (in-process, no spawns) ──────────────────────────────

test.describe("W1226 parseProvenance", () => {
	test("unknown keys drop, strings clamp at MAX_PROV_FIELD", () => {
		const p = parseProvenance(
			JSON.stringify({
				trigger: "t",
				mystery: "nope",
				applicability: "x".repeat(MAX_PROV_FIELD + 50),
				ts: "1760000000000",
			}),
		);
		expect(p).not.toBeNull();
		expect(p?.trigger).toBe("t");
		expect(p?.mystery).toBeUndefined();
		expect(p?.applicability?.length).toBe(MAX_PROV_FIELD);
	});

	test("junk JSON and non-object payloads return null", () => {
		expect(parseProvenance(null)).toBeNull();
		expect(parseProvenance("{broken")).toBeNull();
		expect(parseProvenance(JSON.stringify([1, 2]))).toBeNull();
	});
});

// ─── redact-before-remote (collectFacts) ────────────────────────────────────

function fixtureFactsDb(provByKey: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "w1226-facts-"));
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL, provenance TEXT)",
	);
	const values: Record<string, string> = {
		"lesson.prov": "redaction happens before the wire",
		"lesson.provleak": "value is clean",
		"lesson.secret-prov": "value clean too",
	};
	for (const [key, value] of Object.entries(values)) {
		db.run(
			"INSERT INTO facts (key, value, source, version, ts, provenance) VALUES (?, ?, 'lane', 1, 1, ?)",
			key,
			value,
			provByKey[key] ?? null,
		);
	}
	db.close();
	return dbPath;
}

const state = (): SyncState => ({ facts: {}, metricsAt: 0 });

test.describe("W1226 collectFacts scrub pass", () => {
	test("home-path in provenance redacts in the outbound prov, value intact", () => {
		const dbPath = fixtureFactsDb({
			"lesson.prov": JSON.stringify({
				repo: "/Users/kk/dev/leak-repo", // scrub:allow (fixture: redaction target)
				branch: "main",
			}),
		});
		const out = collectFacts(state(), { dbPath });
		const row = out.send.find((f) => f.key === "lesson.prov");
		expect(row).toBeDefined();
		expect(row?.value).toBe("redaction happens before the wire");
		expect(row?.prov?.repo).toBe("[scrubbed:home-path]/dev/leak-repo");
		expect(row?.prov?.branch).toBe("main");
	});

	test("RFC1918 addr in provenance redacts in the outbound copy", () => {
		const dbPath = fixtureFactsDb({
			"lesson.provleak": JSON.stringify({
				verification: "hub reachable at 192.168.1.40:4101", // scrub:allow (fixture: redaction target)
			}),
		});
		const out = collectFacts(state(), { dbPath });
		const row = out.send.find((f) => f.key === "lesson.provleak");
		expect(row?.prov?.verification).toBe(
			"hub reachable at [scrubbed:rfc1918]:4101",
		);
	});

	test("secret pattern in provenance skips the whole row (evidence never outranks the secret gate)", () => {
		const dbPath = fixtureFactsDb({
			"lesson.secret-prov": JSON.stringify({
				procedure: "token ghp_REDACTEDSECRET1234567890 in env then run", // scrub:allow (fixture: redaction target)
			}),
		});
		const out = collectFacts(state(), { dbPath });
		expect(
			out.send.find((f) => f.key === "lesson.secret-prov"),
		).toBeUndefined();
		expect(
			out.skipped.find((s) => s.startsWith("lesson.secret-prov")),
		).toBeDefined();
	});
});

// ─── hub landing ────────────────────────────────────────────────────────────

function fixtureKb(): Database {
	const kdb = new Database(":memory:");
	kdb.run(
		"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, topic TEXT, fact TEXT, confidence REAL, origin_kind TEXT, origin_system TEXT, origin_sid TEXT, contributors TEXT, source TEXT, state TEXT, confidence_stamp TEXT, provenance TEXT)",
	);
	return kdb;
}

const factRow = (key: string, prov: unknown) => ({
	key,
	value: "v",
	source: "lane",
	version: 1,
	ts: 1,
	...(prov === undefined ? {} : { prov }),
});

test.describe("W1226 hub landing", () => {
	test("provenance lands on the candidate knowledge row, builtin-rules re-scrubbed", () => {
		const kdb = fixtureKb();
		const res = landKnowledgeIngest(kdb, {
			originHub: "devbox",
			metrics: {},
			facts: [
				factRow("lesson.prov", {
					trigger: "t",
					repo: "/Users/kk/dev/leak-repo", // scrub:allow (fixture: redaction target)
					branch: "main",
				}),
			],
		});
		expect(res.ok).toBe(true);
		expect(res.counts?.facts.landed).toBe(1);
		const row = kdb
			.query(
				"SELECT fact, provenance FROM knowledge WHERE topic = 'lesson.prov'",
			)
			.get() as { fact: string; provenance: string | null };
		expect(row.fact).toBe("v");
		const landed = JSON.parse(row.provenance ?? "{}");
		expect(landed.trigger).toBe("t");
		expect(landed.repo).toBe("[scrubbed:home-path]/dev/leak-repo");
	});

	test("unknown prov key rejects the row; legacy prov-less shape still lands", () => {
		const kdb = fixtureKb();
		const bad = landKnowledgeIngest(kdb, {
			originHub: "devbox",
			metrics: {},
			facts: [factRow("lesson.x", { credit_card: "4111" })],
		});
		expect(bad.ok).toBe(true);
		expect(bad.counts?.facts.rejected).toBe(1);
		const legacy = landKnowledgeIngest(kdb, {
			originHub: "devbox",
			metrics: {},
			facts: [factRow("lesson.y", undefined)],
		});
		expect(legacy.ok).toBe(true);
		expect(legacy.counts?.facts.landed).toBe(1);
	});
});
