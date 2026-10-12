// consult-kb.test.ts — the knowledge layer: consult-reply harvests (problem →
// solution) pairs; a repeat consult resolves from the store without routing
// to an expert (--no-kb escapes); unrelated questions stay OPEN; stats/search
// run clean. Isolated temp HOME + repo, spawns the real CLI (monitor recipe).
import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-kb-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-kb-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// projectIdentity(), mirrored: git-common-dir from inside the temp repo —
// Git walks UP through a scaffolded .git to the parent checkout, so
// the identity is the PARENT repo's .git; seeds must match it exactly
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		// resolve, not join: git prints an ABSOLUTE gitdir when the repo root is
		// above cwd (linked-worktree runs) — join would concatenate it into garbage
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const TS = Date.now();
const EXPERT = "expert-sess-11111111";
const ASKER = "asker-sess-22222222";

function run(args: string[]) {
	const versionArgs = ["consult", "consult-reply"].includes(args[0])
		? [
				"--version",
				"test-version",
				...(args[0] === "consult" ? ["--scope", "hooks/leases"] : []),
			]
		: [];
	const p = Bun.spawnSync(["bun", coord, ...args, ...versionArgs], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

function seedSession(sid: string) {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	).run(sid, PROJ, TS, TS);
	db.close();
}

function consultRow(id: number) {
	const db = new Database(DB, { readonly: true });
	const r = db
		.query("SELECT state, answer, expert_sid FROM consults WHERE id = ?")
		.get(id) as
		| { state: string; answer: string | null; expert_sid: string }
		| undefined;
	db.close();
	return r;
}

// bootstrap: the first CLI open runs the migrations — creates the db dir and
// the v3 schema — so the seed helpers have something to write into
run(["kb", "stats"]);

beforeEach(() => {
	const d = new Database(DB);
	d.query("UPDATE consults SET created_at = ? WHERE state = 'OPEN'").run(
		TS - 3_600_001,
	);
	d.close();
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("consult knowledge layer", () => {
	test("kb miss: consult routes OPEN to the live expert", () => {
		seedSession(EXPERT);
		const r = run([
			"consult",
			EXPERT,
			"How do we fix the retry contract for stale leases?",
			"--as",
			ASKER,
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("CONSULT C1");
		expect(consultRow(1)?.state).toBe("OPEN");
	});

	test("consult-reply harvests the pair into the kb", () => {
		const r = run([
			"consult-reply",
			"C1",
			"Release the stale lease via coord lease-release, then re-take the file.",
			"--as",
			EXPERT,
		]);
		expect(r.code).toBe(0);
		expect(consultRow(1)?.state).toBe("ANSWERED");
		const d = new Database(DB, { readonly: true });
		const kb = d
			.query("SELECT problem, solution, asked_by, answered_by FROM consult_kb")
			.all() as {
			problem: string;
			solution: string;
			asked_by: string;
			answered_by: string;
		}[];
		const fts = (
			d.query("SELECT COUNT(*) AS n FROM consult_kb_fts").get() as { n: number }
		).n;
		d.close();
		expect(kb.length).toBe(1);
		expect(kb[0].answered_by).toBe(EXPERT);
		expect(kb[0].solution).toContain("lease-release");
		expect(fts).toBe(1);
		const before = new Database(DB, { readonly: true });
		expect(
			(
				before
					.query("SELECT verified_at FROM consult_trust WHERE kb_id = 1")
					.get() as { verified_at: number | null }
			).verified_at,
		).toBeNull();
		before.close();
		expect(
			run([
				"consult-reply",
				"C1",
				"--feedback",
				"resolved",
				"--evidence",
				"Lease released and subsequent take succeeded",
				"--as",
				ASKER,
			]).code,
		).toBe(0);
	});

	test("repeat question resolves from kb: no expert round-trip, provenance recorded", () => {
		const r = run([
			"consult",
			EXPERT,
			"What is the way to fix the retry contract for stale leases here?",
			"--as",
			ASKER,
		]);
		expect(r.out).toContain("knowledge base");
		const row = consultRow(2);
		expect(row?.state).toBe("KB");
		expect(row?.answer).toContain("lease-release");
		expect(row?.expert_sid).toBe(EXPERT); // provenance: who solved it originally
		const d = new Database(DB, { readonly: true });
		expect(
			(
				d.query("SELECT hits FROM consult_kb WHERE id = 1").get() as {
					hits: number;
				}
			).hits,
		).toBe(1);
		const ev = d
			.query(
				"SELECT payload FROM events WHERE target = ? AND kind = 'consult.answer' ORDER BY id DESC LIMIT 1",
			)
			.get(ASKER) as { payload: string };
		expect(JSON.parse(ev.payload).kb.expert_live).toBe(true);
		d.close();
	});

	test("--no-kb forces live-expert routing despite a stored hit", () => {
		const r = run([
			"consult",
			EXPERT,
			"fix the retry contract for stale leases",
			"--no-kb",
			"--as",
			ASKER,
		]);
		expect(r.out).toContain("CONSULT C3");
		expect(consultRow(3)?.state).toBe("OPEN");
	});

	test("unrelated question stays OPEN (all-terms AND match, high precision)", () => {
		const r = run([
			"consult",
			EXPERT,
			"which ports does the llm stack listen on",
			"--as",
			ASKER,
		]);
		expect(r.out).toContain("CONSULT C4");
		expect(consultRow(4)?.state).toBe("OPEN");
	});

	test("kb stats and search run clean", () => {
		const stats = run(["kb", "stats"]);
		expect(stats.code).toBe(0);
		expect(stats.out).toContain("solutions");
		expect(stats.out).toContain("outcomes:");
		const search = run(["kb", "search", "retry contract stale leases"]);
		expect(search.out).toContain("lease-release");
		const miss = run([
			"kb",
			"search",
			"totally unrelated words about databases",
		]);
		expect(miss.code).toBe(1);
	});
});

// Lessons accompany consultation as advisory context; lexical overlap is
// insufficient evidence for automatic resolution. --no-kb bypasses guidance.
describe("lesson teeth", () => {
	const LQ = "how do we handle sync parity between the repos";
	test("a lesson is advisory context and does not bypass verified consultation", () => {
		const set = run([
			"fact",
			"set",
			"lesson.testsync",
			"always check sync parity before suspenders claude file syncs",
		]);
		expect(set.code).toBe(0);
		const c = run(["consult", EXPERT, LQ, "--as", ASKER]);
		expect(c.out).toContain("CONSULT");
		const id = Number(c.out.match(/C(\d+)/)?.[1]);
		const row = consultRow(id);
		expect(row?.state).toBe("OPEN");
		expect(row?.expert_sid).toBe(EXPERT);
		const db = new Database(DB, { readonly: true });
		const routed = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind = 'consult' AND json_extract(payload, '$.consult') = ?",
				)
				.get(`C${id}`) as { n: number }
		).n;
		db.close();
		expect(routed).toBe(1);
	});

	test("--no-kb bypasses lessons and routes to the expert", () => {
		const c = run(["consult", EXPERT, LQ, "--no-kb", "--as", ASKER]);
		expect(c.out).toContain("CONSULT");
		const id = Number(c.out.match(/C(\d+)/)?.[1]);
		expect(consultRow(id)?.state).toBe("OPEN");
	});

	test("unrelated questions route normally", () => {
		const c = run([
			"consult",
			EXPERT,
			"favorite coffee preference of astronauts",
			"--as",
			ASKER,
		]);
		expect(c.out).toContain("CONSULT");
		const id = Number(c.out.match(/C(\d+)/)?.[1]);
		expect(consultRow(id)?.state).toBe("OPEN");
	});
});

// W449 regression: boolean flags used to swallow the next positional, so
// `consult --best "q"` and `consult <sid> --no-kb "q"` died with usage
// errors. Assert on the message shape (a parse failure says "usage:" or
// "unknown option"); valid run outcomes (knowledge hit, no-ranked-expert,
// OPEN consult) may all exit non-zero via die() — that is routing, not
// parsing.
describe("consult flag placement (W449)", () => {
	test("--best before the question parses (knowledge-first may answer)", () => {
		seedSession(ASKER);
		const r = run([
			"consult",
			"--best",
			"how do leases guard spawn?",
			"--as",
			ASKER,
		]);
		expect(r.err).not.toContain("usage:");
		expect(r.err).not.toContain("unknown option");
		expect(r.out + r.err).not.toContain("usage: consult");
	});

	test("expert --no-kb between expert and question parses", () => {
		seedSession(EXPERT);
		seedSession(ASKER);
		const r = run([
			"consult",
			EXPERT,
			"--no-kb",
			"lease routing question",
			"--as",
			ASKER,
		]);
		expect(r.err).not.toContain("usage:");
		expect(r.err).not.toContain("unknown option");
	});
});

describe("verified cache boundaries", () => {
	test("cached answer works before best-expert selection even with no live expert", () => {
		const d = new Database(DB);
		d.query("UPDATE sessions SET state = 'CLOSED'").run();
		d.close();
		const r = run([
			"consult",
			"--best",
			"fix the retry contract for stale leases",
			"--as",
			ASKER,
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("knowledge base");
		seedSession(EXPERT);
	});
	test("different version and scope cannot reuse verified answer", () => {
		for (const flags of [
			["--version", "new-version"],
			["--scope", "other/package"],
		]) {
			const r = run([
				"consult",
				EXPERT,
				"fix the retry contract for stale leases",
				...flags,
				"--as",
				ASKER,
			]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("CONSULT");
		}
	});
	test("same question in another project cannot reuse answer", () => {
		const d = new Database(DB);
		d.query("UPDATE consult_kb SET project = ? WHERE id = 1").run(
			"other-project",
		);
		const r = run([
			"consult",
			EXPERT,
			"fix the retry contract for stale leases",
			"--as",
			ASKER,
		]);
		expect(r.out).toContain("CONSULT");
		d.query("UPDATE consult_kb SET project = ? WHERE id = 1").run(PROJ);
		d.close();
	});
	test("failed outcome revokes a previously verified cached answer", () => {
		const r = run([
			"consult",
			EXPERT,
			"fix the retry contract for stale leases",
			"--as",
			ASKER,
		]);
		const cid = r.out.match(/C\d+/)?.[0] ?? "";
		expect(r.out).toContain("knowledge base");
		expect(
			run([
				"consult-reply",
				cid,
				"--feedback",
				"resolved",
				"--evidence",
				"works",
				"--as",
				EXPERT,
			]).code,
		).toBe(2);
		expect(
			run([
				"consult-reply",
				cid,
				"--feedback",
				"failed",
				"--evidence",
				"lease take still failed",
				"--as",
				ASKER,
			]).code,
		).toBe(0);
		expect(
			run([
				"consult",
				EXPERT,
				"fix the retry contract for stale leases",
				"--as",
				ASKER,
			]).out,
		).toContain("CONSULT");
	});
});

describe("candidate trust and bounded routing", () => {
	test("unverified answers never automatically resolve repeat questions", () => {
		const q = "candidate-only zebra protocol configuration";
		const first = run(["consult", EXPERT, q, "--as", ASKER]);
		const cid = first.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", cid, "Try the zebra reset", "--as", EXPERT]).code,
		).toBe(0);
		expect(run(["consult", EXPERT, q, "--as", ASKER]).out).toContain("CONSULT");
	});
	test("unknown scopes do not reuse verified answers", () => {
		expect(
			run([
				"consult",
				EXPERT,
				"fix the retry contract for stale leases",
				"--scope",
				"",
				"--as",
				ASKER,
			]).out,
		).toContain("CONSULT");
	});
	test("changed code versions and evidence-free feedback cannot verify a candidate", () => {
		const q = "version-sensitive zebra configuration failure";
		const first = run(["consult", EXPERT, q, "--as", ASKER]);
		const cid = first.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", cid, "Adjust the zebra config", "--as", EXPERT])
				.code,
		).toBe(0);
		expect(
			run(["consult-reply", cid, "--feedback", "resolved", "--as", ASKER]).err,
		).toContain("requires --evidence");
		expect(
			run([
				"consult-reply",
				cid,
				"--feedback",
				"resolved",
				"--evidence",
				"worked",
				"--version",
				"changed-code",
				"--as",
				ASKER,
			]).err,
		).toContain("code version changed");
	});

	test("routing stops when an expert has three recent open consults", () => {
		for (let i = 0; i < 3; i++)
			expect(
				run(["consult", EXPERT, `bounded queue question ${i}`, "--as", ASKER])
					.code,
			).toBe(0);
		const blocked = run([
			"consult",
			EXPERT,
			"bounded queue fourth question",
			"--as",
			ASKER,
		]);
		expect(blocked.code).toBe(2);
		expect(blocked.err).toContain("queue is full");
	});
});

// W618: the reply harvest used to insert every answer unconditionally; it now
// fingerprints problem+answer (normalized tokens) and merges repeat rows.
describe("harvest dedup (W618)", () => {
	test("identical repeat answer merges: one row, hits bumped, last_hit_at set", () => {
		const q = "dedup alpha protocol retry question";
		let r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c1 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run([
				"consult-reply",
				c1,
				"Reset the alpha protocol flag first",
				"--as",
				EXPERT,
			]).code,
		).toBe(0);
		r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c2 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(r.out).toContain("CONSULT"); // unverified candidate: no auto-resolve
		expect(
			run([
				"consult-reply",
				c2,
				"Reset the alpha protocol flag first",
				"--as",
				EXPERT,
			]).code,
		).toBe(0);
		const d = new Database(DB, { readonly: true });
		const rows = d
			.query("SELECT hits, last_hit_at FROM consult_kb WHERE problem = ?")
			.all(q) as { hits: number; last_hit_at: number | null }[];
		d.close();
		expect(rows.length).toBe(1);
		expect(rows[0].hits).toBe(1);
		expect(rows[0].last_hit_at).not.toBeNull();
	});

	test("a differing answer to the same question appends as a refinement", () => {
		const q = "dedup beta cache flush question";
		let r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c1 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", c1, "Run the beta flush script", "--as", EXPERT])
				.code,
		).toBe(0);
		r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c2 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run([
				"consult-reply",
				c2,
				"Also clear the beta cache before flushing",
				"--as",
				EXPERT,
			]).code,
		).toBe(0);
		const d = new Database(DB, { readonly: true });
		const row = d
			.query("SELECT solution, hits FROM consult_kb WHERE problem = ?")
			.get(q) as { solution: string; hits: number };
		d.close();
		expect(row.solution).toContain("Run the beta flush script");
		expect(row.solution).toContain("Also clear the beta cache");
		expect(row.hits).toBe(1);
	});

	test("merged consults stay feedback-eligible via consult_reuse", () => {
		const q = "dedup gamma lease question";
		let r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c1 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", c1, "Release the gamma lease first", "--as", EXPERT])
				.code,
		).toBe(0);
		r = run(["consult", EXPERT, q, "--as", ASKER]);
		const c2 = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", c2, "Release the gamma lease first", "--as", EXPERT])
				.code,
		).toBe(0);
		// feedback on the MERGED consult resolves the shared candidate
		expect(
			run([
				"consult-reply",
				c2,
				"--feedback",
				"resolved",
				"--evidence",
				"gamma lease released and take succeeded",
				"--as",
				ASKER,
			]).code,
		).toBe(0);
		const d = new Database(DB, { readonly: true });
		const reuse = (
			d
				.query("SELECT COUNT(*) AS n FROM consult_reuse WHERE consult_id = ?")
				.get(Number(c2.slice(1))) as { n: number }
		).n;
		const trust = d
			.query(
				"SELECT resolved FROM consult_trust WHERE kb_id = (SELECT id FROM consult_kb WHERE problem = ?)",
			)
			.get(q) as { resolved: number };
		d.close();
		expect(reuse).toBe(1);
		expect(trust.resolved).toBe(1);
	});

	test("a different question still forks a fresh row", () => {
		const qa = "dedup delta unique question one";
		let r = run(["consult", EXPERT, qa, "--as", ASKER]);
		const ca = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", ca, "Reset the delta flag", "--as", EXPERT]).code,
		).toBe(0);
		const qb = "dedup epsilon unrelated question two";
		r = run(["consult", EXPERT, qb, "--as", ASKER]);
		const cb = r.out.match(/C\d+/)?.[0] ?? "";
		expect(
			run(["consult-reply", cb, "Reset the delta flag", "--as", EXPERT]).code,
		).toBe(0);
		const d = new Database(DB, { readonly: true });
		const counts = d
			.query(
				"SELECT problem, COUNT(*) AS n FROM consult_kb WHERE problem IN (?, ?) GROUP BY problem",
			)
			.all(qa, qb) as { problem: string; n: number }[];
		d.close();
		expect(counts.find((c) => c.problem === qa)?.n).toBe(1);
		expect(counts.find((c) => c.problem === qb)?.n).toBe(1);
	});
});
