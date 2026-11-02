// W862: hub-policy provenance disclosure — the board decision record carries
// the validated NEED_DECISION payload.policy (card pill + provenance line),
// and the dispatch brief discloses OPEN policy decisions for the repo as
// provenance lines (read-only graph read — compliance re-checks at session
// bootstrap, never at dispatch).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { policySrcOf } from "../hooks/board-html/klh-decisions.ts";
import {
	openPolicyDecisions,
	policyBriefLines,
} from "../hooks/lib/policy/session-policy.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, test.afterAll);
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
test.afterAll(() => db.close());

const PROJECT = fixture.REPO;
const sha = "a".repeat(64);
const policy = {
	hub: "https://corp.example",
	sha256: sha,
	id: "corp.health",
	source: "operator:corp-v1",
};
const seed = (payload: Record<string, unknown>, target: string): number =>
	Number(
		db
			.query(
				"INSERT INTO events (ts, source, kind, payload, target) VALUES (?, 'policy-disclosure-test', 'NEED_DECISION', ?, ?)",
			)
			.run(Date.now(), JSON.stringify(payload), target).lastInsertRowid,
	);

const healthEvent = seed(
	{
		project: PROJECT,
		note: "This service lacks a health endpoint. Implement one?",
		policy,
		options: ["Implement", "Later"],
	},
	"lane-a",
);
seed({ project: PROJECT, note: "plain consult, no policy" }, "lane-a");
seed(
	{
		project: PROJECT,
		note: "broken content pin must never disclose",
		policy: { ...policy, sha256: "zz" },
	},
	"lane-a",
);
seed({ project: "/elsewhere/.git", note: "foreign project", policy }, "lane-x");
const dupEvent = seed(
	{
		project: PROJECT,
		note: "This service lacks a health endpoint. Implement one?",
		policy,
		options: ["Implement", "Later"],
	},
	"lane-b",
);

async function feed(query: string): Promise<{
	decisions: { id: number; policy: unknown; question: string }[];
}> {
	const response = await fetch(`${fixture.BASE}/api/decisions${query}`);
	expect(response.ok).toBe(true);
	return response.json();
}

test.describe("policy provenance disclosure (W862) @unit", () => {
	test("board record carries the validated policy payload; broken pins and plain forks stay null", async () => {
		const data = await feed(`?project=${encodeURIComponent(PROJECT)}`);
		const health = data.decisions.find((d) => d.id === healthEvent);
		const plain = data.decisions.find(
			(d) => d.question === "plain consult, no policy",
		);
		const broken = data.decisions.find(
			(d) => d.question === "broken content pin must never disclose",
		);
		expect(health.policy).toEqual(policy);
		expect(plain.policy).toBeNull();
		expect(broken.policy).toBeNull();
	});

	test("openPolicyDecisions scopes, validates, and dedupes one line per gap", () => {
		const open = openPolicyDecisions(db, PROJECT);
		expect(open).toHaveLength(1);
		expect(open[0].hub).toBe("https://corp.example");
		expect(open[0].sha256).toBe(sha);
		expect(open[0].row).toBe("corp.health");
		expect(open[0].source).toBe("operator:corp-v1");
		expect(open[0].question).toContain("health endpoint");
		// the foreign-project fork never leaks into this repo's disclosure
		expect(
			openPolicyDecisions(db, "/elsewhere/.git").map((d) => d.row),
		).toEqual(["corp.health"]);
	});

	test("brief lines carry hub/row/pin provenance and collapse sibling re-asks", () => {
		const lines = policyBriefLines(db, PROJECT);
		expect(lines[0]).toBe(
			"POLICY PROVENANCE — 1 open corporate-policy decision for this repo:",
		);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("  - decision #");
		expect(lines[1]).toContain("hub=https://corp.example");
		expect(lines[1]).toContain("row=corp.health");
		expect(lines[1]).toContain(`sha256=${sha}`);
		expect(lines[1]).toContain("This service lacks a health endpoint");
	});

	test("answering the gap's decisions retires the disclosure", () => {
		db.query(
			"UPDATE decisions SET state='ANSWERED' WHERE event_id IN (?, ?)",
		).run(healthEvent, dupEvent);
		expect(policyBriefLines(db, PROJECT).join("\n")).not.toContain(
			"corp.health",
		);
	});

	test("policy provenance line carries hub/row/pin; plain cards carry none", () => {
		// the klh-decisions leaf renders the .dpol pill + .dsrc provenance
		// line as lit-html text (W2550.1); the browser corpus pins the
		// rendered card — this pins the disclosed vocabulary
		expect(policySrcOf(policy)).toBe(
			"policy provenance: hub https://corp.example · row corp.health · pin aaaaaaaaaaaa…",
		);
	});
});
