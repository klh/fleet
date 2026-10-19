import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	recordKnowledgeSuggestion,
	renderKnowledgeSuggestion,
	suggestKnowledge,
} from "../hooks/lib/kev-curation.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
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
