import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	recordKnowledgeSuggestion,
	renderKnowledgeSuggestion,
	suggestKnowledge,
} from "../hooks/lib/knowledge/kev-curation.ts";

const originalFetch = globalThis.fetch;
test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

function answer(choice: string, confidence: number): Response {
	return Response.json({
		model: "kev-latest",
		answers: {
			d: {
				choice,
				confidence,
				probabilities: { store: confidence, noise: 0.1, review: 0.1 },
			},
		},
	});
}

test("Kev suggests a candidate without writing knowledge or changing trust", async () => {
	globalThis.fetch = async () => answer("store", 0.88);
	const verdict = await suggestKnowledge({
		kind: "work",
		title: "Fix stale hub probes",
		text: "Independent health checks must run outside the served process.",
		reference: "W42",
	});
	expect(verdict.choice).toBe("store");
	expect(renderKnowledgeSuggestion(verdict)).toContain("knowledge-enqueue");
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	recordKnowledgeSuggestion(db, verdict, { sid: "agent-1", project: "fleet" });
	const row = db
		.query("SELECT kind, scope, payload, target FROM events")
		.get() as {
		kind: string;
		scope: string;
		payload: string;
		target: string;
	};
	expect(row.kind).toBe("knowledge.suggested");
	expect(row.scope).toBe("fleet");
	expect(row.target).toBe("agent-1");
	expect(JSON.parse(row.payload).reference).toBe("W42");
	db.close();
});

test("low confidence and unavailable Kev never approve a store", async () => {
	globalThis.fetch = async () => answer("store", 0.3);
	const review = await suggestKnowledge({
		kind: "consult",
		title: "One-off answer",
		text: "Maybe useful",
		reference: "C12",
	});
	expect(review.choice).toBe("review");
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	const unavailable = await suggestKnowledge({
		kind: "capsule",
		title: "Checkpoint",
		text: "Next step",
		reference: "W42",
	});
	expect(unavailable.choice).toBe("unavailable");
});

test("long evidence stays within Kev's trained state window", async () => {
	let state = "";
	globalThis.fetch = async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		state = request.state;
		return answer("review", 0.7);
	};
	await suggestKnowledge({
		kind: "work",
		title: "Inspect consult routing",
		text: `opening-${"x".repeat(4000)}-closing`,
		reference: "W42",
	});
	expect(state.length).toBeLessThan(1100);
	expect(state).toContain("opening-");
	expect(state).toContain("-closing");
});
