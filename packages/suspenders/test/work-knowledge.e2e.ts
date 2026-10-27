import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { queueCompletionKnowledge } from "../hooks/lib/work/work-knowledge.ts";
import type { CompletionRecord } from "../hooks/lib/work/work-completion-record.ts";
import type { KevCuration } from "../hooks/lib/knowledge/kev-curation.ts";

const record: CompletionRecord = {
	project: "fleet",
	item: "W946",
	summary:
		"The old FTS content reference broke knowledge ingest after a database split.",
	summary_hash: "hash",
	commit_sha: "abc123",
	baseline_sha: null,
	completed_by: "lane-1",
	completed_at: 1,
	capsule_json: "{}",
	evidence_json: "{}",
};
const verdict = (choice: KevCuration["choice"]): KevCuration => ({
	kind: "work",
	reference: record.item,
	choice,
	confidence: choice === "review" ? 0.2 : 0.9,
	model: "kev-latest",
	suggestion: "review",
});
const db = () => {
	const value = new Database(":memory:");
	value.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	return value;
};

test("completed lane evidence enters the candidate queue with provenance", async () => {
	const store = db();
	const jobs: Record<string, unknown>[] = [];
	const result = await queueCompletionKnowledge(
		store,
		record,
		"Repair FTS",
		verdict("review"),
		async (job) => {
			jobs.push(job);
			return 193;
		},
	);
	expect(result).toEqual({ status: "queued", qid: 193 });
	expect(jobs[0]).toMatchObject({
		source: "work.done W946",
		originSid: "lane-1",
		domain: "private",
	});
	expect(String(jobs[0]?.payload)).toContain("abc123");
	const event = store.query("SELECT kind, payload FROM events").get() as {
		kind: string;
		payload: string;
	};
	expect(event.kind).toBe("knowledge.enqueued");
	expect(JSON.parse(event.payload)).toMatchObject({
		work: "W946",
		project: "fleet",
		qid: 193,
	});
	store.close();
});

test("Kev noise skips ingest; an enqueue failure leaves a visible event", async () => {
	const store = db();
	let calls = 0;
	const enqueue = async () => {
		calls++;
		throw new Error("offline");
	};
	expect(
		await queueCompletionKnowledge(
			store,
			record,
			"Repair FTS",
			verdict("noise"),
			enqueue,
		),
	).toEqual({ status: "skipped" });
	expect(calls).toBe(0);
	expect(
		await queueCompletionKnowledge(
			store,
			record,
			"Repair FTS",
			verdict("unavailable"),
			enqueue,
		),
	).toEqual({ status: "failed" });
	expect(calls).toBe(1);
	expect(
		(store.query("SELECT kind FROM events").get() as { kind: string }).kind,
	).toBe("knowledge.enqueue_failed");
	store.close();
});
