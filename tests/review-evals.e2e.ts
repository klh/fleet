// tests/review-evals.e2e.ts — W1476: incidents become evals (paas standard
// line 851 — every revert or incident adds a case). Proves the post-merge
// trigger: the C156 revert classifier, landing-range revert detection
// (branch-internal undos and re-lands dropped), one review.incident event
// per commit + one deduplicated, tagged arena-case item per revert or
// incident root, and the merge-ladder wiring end to end through a real
// fleet-loop cycle. Store work runs in HOME-isolated children
// (./helpers/review-evals.fixture.ts); spec-file shape law: imports + test
// registrations only, plain statements inside test bodies.
import { expect, test } from "@playwright/test";
import {
	caseText,
	classifyRevert,
	revertLandings,
} from "../packages/suspenders/hooks/lib/fleet-loop/review-evals.ts";
import {
	bankLanding,
	caseItems,
	commitFile,
	dropRepo,
	head,
	identity,
	incidentEvents,
	landRevertThroughLadder,
	loopLog,
	mint,
	revertCommit,
	tempRepo,
} from "./helpers/review-evals.fixture.ts";

test.describe("W1476 review evals: incident cases", { tag: "@api" }, () => {
	test("classifyRevert: C156 contract — named, subject-only, re-lands, plain", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		expect(
			classifyRevert('Revert "W1 add x"', `This reverts commit ${sha}.\n`),
		).toEqual({ reverts: sha });
		expect(
			classifyRevert("Back out the board storm", `This reverts commit ${sha}.`),
		).toEqual({ reverts: sha });
		expect(classifyRevert('Revert "W1 add x"', "")).toEqual({ reverts: null });
		expect(
			classifyRevert(
				'Revert "Revert "W1 add x""',
				`This reverts commit ${sha}.`,
			),
		).toBeNull();
		expect(
			classifyRevert('Reapply "W1 add x"', `This reverts commit ${sha}.`),
		).toBeNull();
		expect(
			classifyRevert("W2 teach the reverter", 'prose about Revert "x"'),
		).toBeNull();
	});

	test("revertLandings: main-target reverts land; branch-internal undos and re-lands drop", () => {
		const repo = tempRepo();
		try {
			const x = commitFile(repo, "x.txt", "x\n", "W1 add x");
			const before = head(repo);
			const r = revertCommit(repo, x);
			const y = commitFile(repo, "y.txt", "y\n", "W2 add y");
			revertCommit(repo, y);
			revertCommit(repo, r);
			expect(revertLandings(repo, before, head(repo))).toEqual([
				{ commit: r, subject: 'Revert "W1 add x"', reverts: x },
			]);
			expect(revertLandings(repo, r, head(repo))).toEqual([]);
		} finally {
			dropRepo(repo);
		}
	});

	test("revert landing: one event + one tagged arena case; a re-run dedupes", () => {
		const repo = tempRepo();
		try {
			const x = commitFile(repo, "x.txt", "x\n", "W1 add x");
			const before = head(repo);
			const r = revertCommit(repo, x);
			const item = mint(repo, "lane that reverted x");
			const lines = bankLanding(repo, item, before, r);
			expect(lines).toEqual([
				`REVIEW-INCIDENT revert ${r.slice(0, 10)} → arena case ${incidentEvents(repo)[0]?.case}`,
			]);
			expect(bankLanding(repo, item, before, r)).toEqual([]);
			const events = incidentEvents(repo);
			const cases = caseItems(repo);
			expect(events).toHaveLength(1);
			expect(cases).toHaveLength(1);
			expect(events[0]).toEqual({
				scope: cases[0]?.id,
				source: "w1476-test",
				project: identity(repo),
				class: "revert",
				commit: r,
				reverts: x,
				work: item,
				mergedSha: r,
				case: cases[0]?.id,
				subject: 'Revert "W1 add x"',
				incident: null,
			});
			expect(cases[0]?.title).toBe(
				`Add review-arena case for revert ${r.slice(0, 10)}: Revert "W1 add x"`,
			);
			expect(cases[0]?.tags?.split(",").sort()).toEqual([
				"arena-case",
				"review",
			]);
			expect(cases[0]?.description).toContain(
				"packages/belt/bench/arena/review-incident.ts",
			);
			expect(cases[0]?.description).toContain(`sha ${r}`);
		} finally {
			dropRepo(repo);
		}
	});

	test("incident: the tagged root keys one case across landings; untagged landings bank nothing", () => {
		const repo = tempRepo();
		try {
			const root = mint(repo, "Board payload storm", ["--tag", "incident"]);
			const part1 = mint(repo, "storm fix part 1", ["--parent", root]);
			const part2 = mint(repo, "storm fix part 2", ["--parent", root]);
			const plain = mint(repo, "ordinary work");
			const b1 = head(repo);
			const c1 = commitFile(repo, "a.txt", "a\n", "storm fix part 1");
			expect(bankLanding(repo, part1, b1, c1)).toHaveLength(1);
			const c2 = commitFile(repo, "b.txt", "b\n", "storm fix part 2");
			expect(bankLanding(repo, part2, c1, c2)).toHaveLength(1);
			const c3 = commitFile(repo, "c.txt", "c\n", "ordinary change");
			expect(bankLanding(repo, plain, c2, c3)).toEqual([]);
			const events = incidentEvents(repo);
			const cases = caseItems(repo);
			expect(cases).toHaveLength(1);
			expect(cases[0]?.title).toBe(
				`Add review-arena case for incident ${root}: Board payload storm`,
			);
			expect(
				events.map((e) => [e.class, e.commit, e.work, e.incident]),
			).toEqual([
				["incident", c1, part1, root],
				["incident", c2, part2, root],
			]);
			expect(events.map((e) => e.case)).toEqual([cases[0]?.id, cases[0]?.id]);
			expect(events[0]?.subject).toBe("storm fix part 1");
		} finally {
			dropRepo(repo);
		}
	});

	test("caseText: incident roots title the case; reverts name what they undo", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		const text = caseText(
			{
				class: "revert",
				commit: sha,
				reverts: "fedcba9876543210fedcba9876543210fedcba98",
				subject: 'Revert "W9 widen the lane cap"',
				incident: { id: "W7", title: "Lane cap storm" },
			},
			"W9.1",
			sha,
		);
		expect(text.title).toBe(
			"Add review-arena case for incident W7: Lane cap storm",
		);
		expect(text.description).toContain("undoing fedcba9876");
		expect(text.description).toContain("with W9.1 under incident W7");
		expect(text.description).toContain("--rescore");
	});

	test("merge ladder: a lane branch reverting a main commit banks the case at merge time", () => {
		test.setTimeout(240_000);
		const repo = tempRepo();
		try {
			const landing = landRevertThroughLadder(repo);
			expect(landing.code, landing.out).toBe(0);
			expect(loopLog(repo)).toContain("MERGED");
			expect(loopLog(repo)).toContain(
				`REVIEW-INCIDENT revert ${landing.revert.slice(0, 10)}`,
			);
			expect(loopLog(repo)).not.toContain("REVIEW-EVALS-FAILED");
			const events = incidentEvents(repo);
			expect(events).toHaveLength(1);
			expect(events[0]?.class).toBe("revert");
			expect(events[0]?.commit).toBe(landing.revert);
			expect(events[0]?.reverts).toBe(landing.reverted);
			expect(events[0]?.work).toBe(landing.item);
			expect(events[0]?.source).toBe("fleet-loop");
			expect(caseItems(repo).map((c) => c.id)).toEqual([events[0]?.case]);
		} finally {
			dropRepo(repo);
		}
	});
});
