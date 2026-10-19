// W931 — the co-supervisor ingress: external agents ride the existing board
// wire (write token, W264 perimeter) into the coord plane. Every POST spawns
// the real coord CLI, so these tests exercise the consult/refusal/KB seams
// end to end against a scratch governor.db.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000);

const f = await boardFixture(0, (fn) => afterAll(fn));
const AGENT = "chatgpt-test";
const BODY = { project: f.MY_PROJ, sid: AGENT };
// the ingress validates {project} against the registered project list —
// seed one work row so the fixture project exists on the plane
f.addWork("W931 ingress seed");

const dbPath = () => `${f.HOME}/.cache/claude-governor/governor.db`;
function q1<T>(sql: string, ...params: unknown[]): T | null {
	const db = new Database(dbPath(), { readonly: true });
	try {
		return (db.query(sql).get(...params) ?? null) as T | null;
	} finally {
		db.close();
	}
}
function qAll<T>(sql: string, ...params: unknown[]): T[] {
	const db = new Database(dbPath(), { readonly: true });
	try {
		return db.query(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}
const postNoToken = async (path: string, body: unknown) => {
	const r = await fetch(`${f.BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, json: await r.json() };
};

describe("W931 consult ingress", () => {
	test("writes need the write token (W264, unchanged)", async () => {
		const r = await postNoToken("/api/consult", { ...BODY, q: "hi" });
		expect(r.status).toBe(403);
	});

	test("unknown project 404s", async () => {
		const r = await f.post("/api/consult", {
			project: "/no/such/project",
			sid: AGENT,
			q: "hi",
		});
		expect(r.status).toBe(404);
	});

	test("bad sid 400s", async () => {
		const r = await f.post("/api/consult", { ...BODY, sid: "", q: "hi" });
		expect(r.status).toBe(400);
	});

	test("targeted consult mints the external session and opens a consult", async () => {
		const r = await f.post("/api/consult", {
			...BODY,
			q: "what owns the lane registry?",
			target: AGENT,
		});
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		expect(r.json.state).toBe("OPEN");
		expect(r.json.consult).toMatch(/^C\d+$/);
		const sess = q1<{ role: string; state: string }>(
			"SELECT role, state FROM sessions WHERE sid = ?",
			AGENT,
		);
		expect(sess?.role).toBe("external");
		expect(sess?.state).toBe("RUNNING");
	});

	test("outbox pull face shows the OPEN consult", async () => {
		const r = await fetch(`${f.BASE}/api/outbox/${AGENT}`);
		const j = await r.json();
		expect(j.ok).toBe(true);
		expect(j.consults.length).toBeGreaterThan(0);
		expect(j.consults[0].state).toBe("OPEN");
	});

	test("--best with no live experts refuses honestly (W923 event)", async () => {
		const r = await f.post("/api/consult", {
			...BODY,
			q: "unique refused question w931",
			best: true,
		});
		expect(r.status).toBe(200);
		expect(r.json.state).toBe("REFUSED");
		const ev = q1<{ id: number }>(
			"SELECT id FROM events WHERE kind = 'consult' AND payload LIKE '%REFUSED%' ORDER BY id DESC LIMIT 1",
		);
		expect(ev).not.toBeNull();
	});

	test("identical question dedups within the window", async () => {
		const body = { ...BODY, q: "dedup probe question w931", target: AGENT };
		const first = await f.post("/api/consult", body);
		const second = await f.post("/api/consult", body);
		expect(first.json.ok).toBe(true);
		expect(second.json.deduped).toBe(true);
		expect(second.json.consult).toBe(first.json.consult);
	});

	test("live non-external sid refuses takeover", async () => {
		const boot = f.run("coord.ts", [
			"bootstrap",
			"--as",
			"w931-lane",
			"--role",
			"worker",
		]);
		expect(boot.code).toBe(0);
		const r = await f.post("/api/consult", {
			...BODY,
			sid: "w931-lane",
			q: "hijack attempt",
			target: "w931-lane",
		});
		expect(r.status).toBe(409);
	});

	test("external agent answers a lane consult through the wire", async () => {
		const seeded = f.run("coord.ts", [
			"consult",
			AGENT,
			"lane asks the co-supervisor",
			"--as",
			"w931-asker",
		]);
		expect(seeded.code).toBe(0);
		const outbox = await (await fetch(`${f.BASE}/api/outbox/${AGENT}`)).json();
		const open = outbox.consults.find((c: { question: string }) =>
			c.question.includes("lane asks the co-supervisor"),
		);
		expect(open).toBeDefined();
		const reply = await f.post("/api/consult-reply", {
			...BODY,
			cid: open.consult,
			answer: "the registry is facts lane.*",
		});
		expect(reply.status).toBe(200);
		expect(reply.json.state).toBe("ANSWERED");
		const row = q1<{ state: string; answer: string }>(
			"SELECT state, answer FROM consults WHERE id = ?",
			Number(open.consult.slice(1)),
		);
		expect(row?.state).toBe("ANSWERED");
		expect(row?.answer).toContain("facts lane");
	});

	test("broadcast rides the wire as the agent", async () => {
		const r = await f.post("/api/broadcast", {
			...BODY,
			note: "W931 co-supervisor smoke broadcast",
		});
		expect(r.status).toBe(200);
		const ev = qAll<{ source: string; kind: string }>(
			"SELECT source, kind FROM events WHERE payload LIKE '%W931 co-supervisor smoke broadcast%' ORDER BY id DESC LIMIT 1",
		);
		expect(ev.length).toBe(1);
	});

	test("per-expert consult queue caps at three OPEN (CLI guard surfaces as QUEUE_FULL)", async () => {
		for (let i = 0; i < 5; i++) {
			const r = await f.post("/api/consult", {
				...BODY,
				sid: "chatgpt-flood",
				target: "chatgpt-flood",
				q: `flood ${i}`,
			});
			if (i < 3) expect(r.status).toBe(200);
			else {
				expect(r.status).toBe(429);
				expect(r.json.state).toBe("QUEUE_FULL");
			}
		}
	});

	test("per-sid rate cap answers 429 across POSTs", async () => {
		for (let i = 0; i < 11; i++) {
			const r = await f.post("/api/broadcast", {
				...BODY,
				sid: "chatgpt-rate",
				note: `rate probe ${i}`,
			});
			if (i < 10) expect(r.status).toBe(200);
			else expect(r.status).toBe(429);
		}
	});

	test("coord-agent enroll + smoke run the full loop against the wire", () => {
		const e = f.run("coord-agent.ts", [
			"enroll",
			"chatgpt-e2e",
			"--project",
			f.REPO,
			"--name",
			"ChatGPT co-supervisor",
		]);
		expect(e.code).toBe(0);
		expect(e.out).toContain("/api/consult");
		const s = f.run("coord-agent.ts", [
			"smoke",
			"chatgpt-e2e",
			"--project",
			f.REPO,
			"--base",
			f.BASE,
		]);
		expect(s.code).toBe(0);
		expect(s.out).toContain("SMOKE PASS");
	});
});
