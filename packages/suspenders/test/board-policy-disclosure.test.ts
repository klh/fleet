// W862: hub-policy provenance disclosure — the board decision record carries
// the validated NEED_DECISION payload.policy (card pill + provenance line),
// and the dispatch brief discloses OPEN policy decisions for the repo as
// provenance lines (read-only graph read — compliance re-checks at session
// bootstrap, never at dispatch).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createContext, runInContext } from "node:vm";
import { CORE } from "../hooks/board-html/core.ts";
import { DECISIONS } from "../hooks/board-html/decisions.ts";
import {
	openPolicyDecisions,
	policyBriefLines,
} from "../hooks/lib/policy/session-policy.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());

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

describe("policy provenance disclosure (W862)", () => {
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

	test("decision card renders the policy pill and provenance line; plain cards stay clean", () => {
		const elements = new Map<string, ReturnType<typeof stubEl>>();
		type StubEl = {
			children: StubEl[];
			className: string;
			textContent: string;
			value: string;
			style: Record<string, string>;
			attrs: Record<string, string>;
			q: Record<string, StubEl>;
			classList: { toggle(): void };
			setAttribute(k: string, v: string): void;
			getAttribute(k: string): string | null;
			addEventListener(): void;
			appendChild(c: StubEl): StubEl;
			insertBefore(c: StubEl): StubEl;
			remove(): void;
			replaceChildren(): void;
			focus(): void;
			querySelector(sel: string): StubEl;
		};
		function stubEl(): StubEl {
			return {
				children: [],
				className: "",
				textContent: "",
				value: "",
				style: {} as Record<string, string>,
				classList: { toggle() {} },
				setAttribute(k: string, v: string) {
					if (!this.attrs) this.attrs = {} as Record<string, string>;
					this.attrs[k] = v;
				},
				getAttribute(k: string) {
					return (
						(this.attrs as Record<string, string> | undefined)?.[k] ?? null
					);
				},
				addEventListener() {},
				appendChild(c: unknown) {
					this.children.push(c);
					return c;
				},
				insertBefore(c: unknown) {
					this.children.push(c);
					return c;
				},
				remove() {},
				replaceChildren() {},
				focus() {},
				q: {} as Record<string, StubEl>,
				querySelector(sel: string) {
					if (!this.q[sel]) this.q[sel] = stubEl();
					return this.q[sel];
				},
			};
		}
		const document = {
			activeElement: null,
			getElementById: (id: string) => {
				if (!elements.has(id)) elements.set(id, stubEl());
				return elements.get(id);
			},
			createElement: () => stubEl(),
			querySelector: () => null,
		};
		const context = {
			document,
			DOMParser: class {
				parseFromString() {
					return {
						body: {
							firstElementChild: {
								firstChild: null,
								removeChild: () => null,
							},
						},
					};
				}
			},
			Date,
			sel: { value: "all" },
			drafts: {},
			selOpt: {},
			advising: {},
			advRetry: {},
			advErr: {},
			ansErr: {},
			sentOk: {},
			answering: {},
			decCollapsed: false,
			lastData: null,
			lastDec: null as unknown,
			renderDecisionsInner() {}, // stubbed below
			renderDecisions() {},
		};
		createContext(context);
		runInContext(CORE + DECISIONS, context);
		const record = {
			id: 1,
			project: PROJECT,
			state: "OPEN",
			question: "This service lacks a health endpoint. Implement one?",
			age_s: 10,
			owner_actionable: false,
			delivery: "DELIVERED",
			policy,
		};
		const plain = { ...record, id: 2, policy: null };
		runInContext(
			`lastDec = { decisions: [${JSON.stringify(record)}, ${JSON.stringify(plain)}] }; decNode(lastDec.decisions[0]); decNode(lastDec.decisions[1]);`,
			context,
		);
		const card = elements.get("decList").children[0];
		const card2 = elements.get("decList").children[1];
		expect(card.querySelector(".dpol").textContent).toBe("policy");
		expect(card.querySelector(".dsrc").textContent).toBe(
			"policy provenance: hub https://corp.example · row corp.health · pin aaaaaaaaaaaa…",
		);
		expect(card2.querySelector(".dpol").textContent).toBe("");
		expect(card2.querySelector(".dsrc").textContent).toBe("");
	});
});
