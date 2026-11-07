// distill-verify@unit.e2e.ts — fork G: the verify job re-checks a
// session-derived entry against its own origin transcript (decant.db).
// contradicted/gone → stale mark + a distill-verify proposal; supported →
// a visit stamp only; no origin_sid or an IKEA-local entry never reach the
// chat leg; an unchanged entry is not re-judged (distill_pairs job=verify).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "../hooks/lib/knowledge/distill/runner.ts";
import { openDecant } from "../hooks/lib/knowledge/distill/decant.ts";
import {
	addDecantMessage,
	addDecantSession,
	addEntry,
	decantDb,
	knowledgeDb,
	world,
} from "./fixtures/distill-world.ts";

function seedSession(
	seed: ReturnType<typeof decantDb>,
	sid: string,
	lines: [string, string][],
) {
	const sessionId = addDecantSession(seed, {
		sid,
		project: "/repo/fleet",
		title: "a session",
		ingestedAt: "2026-11-01T00:00:00Z",
	});
	lines.forEach(([role, text], i) => {
		addDecantMessage(seed, sessionId, role, [text], i);
	});
}

test("supported verdict stamps the visit only; contradicted marks stale + proposes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distill-verify-"));
	const path = join(dir, "decant.db");
	const seed = decantDb(path);
	seedSession(seed, "s-ok", [
		["user", "does the router retry on 429?"],
		[
			"assistant",
			"no, it stops the job and never retries into a busy upstream",
		],
	]);
	seedSession(seed, "s-bad", [
		["user", "does the router retry on 429?"],
		["assistant", "correction: it DOES retry three times with backoff"],
	]);
	seed.close();
	const decant = openDecant(path);
	const db = knowledgeDb();
	const okId = addEntry(db, {
		topic: "router stops on 429",
		fact: "the router never retries into a busy upstream",
		originSid: "s-ok",
	});
	const badId = addEntry(db, {
		topic: "router stops on 429",
		fact: "the router never retries into a busy upstream",
		originSid: "s-bad",
	});
	const w = world(db, {
		logDir: dir,
		decant,
		chat: {
			answer: (_system, user) =>
				JSON.stringify(
					user.includes("DOES retry")
						? {
								verdict: "contradicted",
								reason: "transcript now says it retries",
							}
						: { verdict: "supported", reason: "transcript still agrees" },
				),
			tokens: 42,
		},
	});
	try {
		const r = await runOnce(w.deps, { jobs: ["verify"] });
		expect(r.outcome).toBe("ok");
		expect(r.items).toBe(2);
		const ok = db
			.query("SELECT stale_at FROM knowledge WHERE id = ?")
			.get(okId);
		expect(ok.stale_at).toBeNull();
		const bad = db
			.query("SELECT stale_at, stale_reason FROM knowledge WHERE id = ?")
			.get(badId);
		expect(bad.stale_at).not.toBeNull();
		expect(bad.stale_reason).toContain("contradicts");
		const props = db
			.query(
				"SELECT knowledge_id, kind, reason FROM knowledge_proposals WHERE kind = 'distill-verify'",
			)
			.all();
		expect(props.length).toBe(1);
		expect(props[0].knowledge_id).toBe(badId);
		expect(props[0].reason).toContain("contradicted");

		// unchanged input is sig-remembered: a second pass re-asks nothing
		const before = w.up.chat.requests.length;
		db.run("DELETE FROM distill_visits");
		const r2 = await runOnce(w.deps, { jobs: ["verify"] });
		expect(r2.items).toBe(2);
		expect(w.up.chat.requests.length).toBe(before);
	} finally {
		w.close();
		decant.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no origin_sid and IKEA-local entries never reach the chat leg", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distill-verify-"));
	const path = join(dir, "decant.db");
	const seed = decantDb(path);
	seedSession(seed, "s-ikea", [["user", "ikea apim onboarding notes"]]);
	seed.close();
	const decant = openDecant(path);
	const db = knowledgeDb();
	addEntry(db, { topic: "no session", fact: "irrelevant", originSid: null });
	addEntry(db, {
		topic: "finding.ikea-apim-onboarding",
		fact: "ikea-origin detail",
		originSid: "s-ikea",
	});
	const w = world(db, {
		logDir: dir,
		decant,
		chat: {
			answer: () => JSON.stringify({ verdict: "supported" }),
			tokens: 10,
		},
	});
	try {
		const r = await runOnce(w.deps, { jobs: ["verify"] });
		expect(r.items).toBe(2);
		expect(w.up.chat.requests.length).toBe(0);
		const outcomes = db
			.query(
				"SELECT last_outcome FROM distill_visits WHERE job = 'verify' ORDER BY entry_id",
			)
			.all()
			.map((x) => x.last_outcome);
		expect(outcomes).toContain("skip:no-origin");
		expect(outcomes).toContain("skip:local-only");
	} finally {
		w.close();
		decant.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
