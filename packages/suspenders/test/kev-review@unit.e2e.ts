// kev-review@unit.e2e.ts — hub design D7: a missing Kev verdict parks the
// entry in kev_review instead of storing it (fail-open); the drain re-asks
// Kev and routes store → ingest queue, noise → dropped, still-unavailable →
// pending until the attempt cap expires it. The budget is config.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	curationGate,
	deferToReview,
	drainKevReview,
	KEV_CURATION_DEFAULT_MS,
	KEV_REVIEW_MAX_ATTEMPTS,
	kevCurationTimeoutMs,
} from "../hooks/lib/knowledge/kev-review.ts";

const entry = (reference) => ({
	kind: "work",
	reference,
	title: `t ${reference}`,
	text: `body ${reference}`,
	sid: "s1",
	project: "p",
});

test("gate: only a missing verdict defers; review stores as candidate", () => {
	expect(curationGate("unavailable")).toBe("defer");
	expect(curationGate("noise")).toBe("drop");
	expect(curationGate("store")).toBe("store");
	expect(curationGate("review")).toBe("store");
});

test("timeout comes from config, default the warm SLA", () => {
	expect(kevCurationTimeoutMs({})).toBe(KEV_CURATION_DEFAULT_MS);
	expect(
		kevCurationTimeoutMs({ SUSPENDERS_KEV_CURATION_TIMEOUT_MS: "45000" }),
	).toBe(45000);
	expect(
		kevCurationTimeoutMs({ SUSPENDERS_KEV_CURATION_TIMEOUT_MS: "x" }),
	).toBe(KEV_CURATION_DEFAULT_MS);
});

test("drain routes store/noise/unavailable; defer is idempotent", async () => {
	const kb = new Database(":memory:");
	expect(deferToReview(kb, entry("W1"))).toBe(true);
	expect(deferToReview(kb, entry("W1"))).toBe(false);
	deferToReview(kb, entry("W2"));
	deferToReview(kb, entry("W3"));
	const choice = { W1: "store", W2: "noise", W3: "unavailable" };
	const queued = [];
	const r = await drainKevReview(kb, {
		suggest: async (i) => ({
			kind: i.kind,
			reference: i.reference,
			choice: choice[i.reference],
			confidence: null,
			model: null,
			suggestion: "",
		}),
		enqueue: async (job) => {
			queued.push(job.source);
			return queued.length;
		},
		timeoutMs: 1,
	});
	expect(r).toEqual({ stored: 1, dropped: 1, pending: 1, expired: 0 });
	expect(queued).toEqual(["kev-review work W1"]);
	const states = kb
		.query("SELECT reference, state FROM kev_review ORDER BY reference")
		.all();
	expect(states).toEqual([
		{ reference: "W1", state: "stored" },
		{ reference: "W2", state: "dropped" },
		{ reference: "W3", state: "pending" },
	]);
	kb.run(
		`UPDATE kev_review SET attempts = ${KEV_REVIEW_MAX_ATTEMPTS - 1} WHERE reference = 'W3'`,
	);
	const again = await drainKevReview(kb, {
		suggest: async (i) => ({
			kind: i.kind,
			reference: i.reference,
			choice: "unavailable",
			confidence: null,
			model: null,
			suggestion: "",
		}),
		enqueue: async () => 0,
		timeoutMs: 1,
	});
	expect(again.expired).toBe(1);
});
