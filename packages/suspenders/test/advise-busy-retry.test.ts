// advise-busy-retry.test.ts — W1119.1.1 successors (consult C89): the W850
// Retry-After wait/retry retirement stays pinned on the gated chain — a 503
// busy gate is attempted exactly once per advise run (no sleep/retry), the
// run exits 2 with an honest, credential-free error fact, each new run
// re-attempts once, and a Retry-After header invites no wait.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000);

const { HOME, REPO, env, bin } = await boardFixture(0, afterAll);

type Seen = { path: string; key: string | null; body: Record<string, unknown> };

// the W850-successor stub: always answers with `status`; `headers` lets a
// test hang the retired Retry-After invitation on the refusal
function busyStub(status: number, headers: Record<string, string> = {}) {
	const seen: Seen[] = [];
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			seen.push({
				path: new URL(req.url).pathname,
				key: req.headers.get("x-api-key"),
				body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
			});
			if (status !== 200)
				return Response.json({ error: "busy" }, { status, headers });
			return Response.json({
				content: [{ type: "text", text: "RECOMMENDATION: ok" }],
			});
		},
	});
	return {
		seen,
		base: `http://127.0.0.1:${srv.port}`,
		legEnv: {
			SUSPENDERS_BUCKLE_URL: `http://127.0.0.1:${srv.port}`,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_busy",
		},
		stop: () => srv.stop(true),
	};
}

function gdb(): Database {
	const d = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	d.run("PRAGMA busy_timeout = 4000");
	return d;
}

function seedFork(note: string): number {
	const db = gdb();
	const ev = db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'busy-retry-test', 'NEED_DECISION', NULL, ?, 'busy-lane')",
		)
		.run(Date.now(), JSON.stringify({ note }));
	db.close();
	return Number(ev.lastInsertRowid);
}

// async spawn: the stub is an in-process Bun.serve that must answer DURING
// the child (W362)
async function advise(
	id: number,
	legEnv: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
	const child = Bun.spawn(["bun", `${bin}/advise.ts`, String(id)], {
		cwd: REPO,
		env: { ...env, ...legEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code: await child.exited, out, err };
}

test("a 503 busy gate is attempted exactly once — no W850 wait/retry", async () => {
	const s = busyStub(503);
	const id = seedFork("busy single-attempt fork");
	try {
		const r = await advise(id, s.legEnv);
		expect(r.code).toBe(2);
		expect(s.seen).toHaveLength(1);
		expect((s.seen[0] as Seen).path).toBe("/v1/messages");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string } | null;
		expect(errFact?.value).toContain("buckle inference HTTP 503");
		expect(errFact?.value).not.toContain("bksk_busy");
		expect(
			db.query("SELECT value FROM facts WHERE key = ?").get(`advice.${id}`),
		).toBeNull();
		db.close();
	} finally {
		s.stop();
	}
});

describe("advise busy refusal semantics (W1119.1.1)", () => {
	test("each advise run re-attempts once — the next fork tries the gate again", async () => {
		const s = busyStub(503);
		const a = seedFork("busy re-attempt fork a");
		const b = seedFork("busy re-attempt fork b");
		try {
			const ra = await advise(a, s.legEnv);
			expect(ra.code).toBe(2);
			const rb = await advise(b, s.legEnv);
			expect(rb.code).toBe(2);
			expect(s.seen).toHaveLength(2);
			expect((s.seen[0] as Seen).body.model).toBe("local-reason");
			expect((s.seen[1] as Seen).body.model).toBe("local-reason");
		} finally {
			s.stop();
		}
	});
});

test("a Retry-After header invites no wait — the 503 stays single-attempt exit 2", async () => {
	const s = busyStub(503, { "retry-after": "604800" });
	const id = seedFork("busy retry-after fork");
	try {
		const r = await advise(id, s.legEnv);
		expect(r.code).toBe(2);
		expect(s.seen).toHaveLength(1);
		expect((s.seen[0] as Seen).path).toBe("/v1/messages");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string } | null;
		expect(errFact?.value).toContain("buckle inference HTTP 503");
		expect(errFact?.value).not.toContain("bksk_busy");
		db.close();
	} finally {
		s.stop();
	}
});

test("an unconfigured gate rides the unavailable path (exit 0), not the busy failure path", async () => {
	const s = busyStub(503);
	const id = seedFork("busy unconfigured fork");
	try {
		const r = await advise(id, {});
		expect(r.code).toBe(0);
		expect(r.err).toContain("gate unavailable");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string } | null;
		expect(errFact?.value).toContain("unavailable:");
		expect(s.seen).toHaveLength(0);
		db.close();
	} finally {
		s.stop();
	}
});
