// test/consult-feedback-gate.e2e.ts — W2957: the resolved-feedback version
// gate in cmdConsultReply must not refuse on every ref. trust.version is
// "<head>:<dirty-tree hash>" stamped by the ANSWERING lane's tree, so exact
// comparison never matches cross-lane or against a bare --version <sha>.
// Round trips the REAL coord CLI (W932 cliFixture) with the candidate
// seeded through the subprocess seam (the live answer path parks candidates
// with kev offline): resolved feedback accepts an explicit --version
// assertion (short-sha prefix-tolerant) and a same-HEAD run without the
// flag, still refuses a different-HEAD candidate without an assertion.
import { expect, test } from "@playwright/test";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const fx = cliFixture("consult-feedback-gate");
const GOVDB =
	"/Volumes/Sensitive/github/klh/fleet/.worktrees/W2957/packages/suspenders/hooks/lib/govdb/govdb.ts";
const TRUST =
	"/Volumes/Sensitive/github/klh/fleet/.worktrees/W2957/packages/suspenders/hooks/coord/consult-trust.ts";

test.afterAll(() => fx.cleanup());

const coord = (...args: string[]) => fx.run("coord.ts", args);

/** Seed one ANSWERED consult + candidate (consult_kb + consult_trust) whose
 *  trust.version head component = fx.COMMIT. */
const seedCandidate = (question: string): void => {
	fx.seed(`const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const { ensureConsultTrust } = await import(${JSON.stringify(TRUST)});
const db = openGovernorDb();
ensureConsultTrust(db);
const c = db.query("INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES ('p', 'lane-a', 'lane-b', ?, 'hooks/leases', 'ANSWERED', ?)").run(${JSON.stringify(question)}, ${Date.now()});
const kr = db.query("INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at, confidence, confidence_stamp) VALUES (?, 'do this', 'p', 'lane-a', 'lane-b', ?, ?, 0.6, '{}')").run(${JSON.stringify(question)}, c.lastInsertRowid, ${Date.now()});
db.query("INSERT INTO consult_trust (kb_id, scope, version) VALUES (?, 'hooks/leases', ?)").run(kr.lastInsertRowid, ${JSON.stringify(fx.COMMIT)} + ':seedhash');
`);
};

test("resolved feedback: explicit --version and same-HEAD close; stale HEAD refuses", () => {
	expect(coord("bootstrap", "--as", "lane-a").code).toBe(0);
	expect(coord("bootstrap", "--as", "lane-b").code).toBe(0);
	// case A — the W2957 repro: a bare short-sha --version (prefix of the
	// stored "<head>:<dirty hash>" composite) closes the loop
	seedCandidate("first question");
	expect(
		coord(
			"consult-reply",
			"C1",
			"--feedback",
			"resolved",
			"--evidence",
			"applied and observed it work",
			"--version",
			fx.COMMIT.slice(0, 10),
			"--as",
			"lane-a",
		).out,
	).toContain("FEEDBACK C1 resolved");
	// case B — no flag: the asker's consultVersion() head component equals
	// the stored one, so closure needs no assertion
	seedCandidate("second question");
	expect(
		coord(
			"consult-reply",
			"C2",
			"--feedback",
			"resolved",
			"--evidence",
			"applied and observed it work",
			"--as",
			"lane-a",
		).out,
	).toContain("FEEDBACK C2 resolved");
	// case C — an explicit version that does NOT match the stored head also
	// refuses (consult-kb.test.ts pins this intent; the version gate runs
	// before the already-recorded tx, so C2's prior resolution is not hit)
	expect(
		coord(
			"consult-reply",
			"C2",
			"--feedback",
			"resolved",
			"--evidence",
			"applied and observed it work",
			"--version",
			"changed-code",
			"--as",
			"lane-a",
		).err,
	).toContain("candidate code version changed or scope unknown");
	// case D — teeth: a candidate stamped with a DIFFERENT head and no
	// explicit assertion still refuses, and stays unverified for reuse
	seedCandidate("third question");
	fx.ins(
		"UPDATE consult_trust SET version = ? WHERE kb_id = (SELECT id FROM consult_kb WHERE consult_id = 3)",
		[`${"f".repeat(40)}:deadbeef`],
	);
	expect(
		coord(
			"consult-reply",
			"C3",
			"--feedback",
			"resolved",
			"--evidence",
			"applied and observed it work",
			"--as",
			"lane-a",
		).err,
	).toContain("candidate code version changed or scope unknown");
	expect(
		fx.q<{ n: number }>(
			"SELECT COUNT(*) AS n FROM consult_trust t JOIN consult_kb k ON k.id = t.kb_id WHERE k.consult_id = 3 AND t.verified_at IS NOT NULL",
		)[0]?.n,
	).toBe(0);
});
