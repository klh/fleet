// advise-busy-retry.test.ts — W850: the single-leg advise POST retries a
// 503 busy ONCE, honoring Retry-After under the SUSPENDERS_ADVICE_RETRY_CAP_MS
// cap, so a saturated local-reason tier degrades advice late instead of
// instantly ('advice failed' on the card). Pins: retry-then-success stores
// the advice fact; still-busy-after-retry stays an honest provider failure
// (error fact + exit 2), never "unavailable".
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000);

const { HOME, REPO, env, bin } = await boardFixture(0, afterAll);

// stub that 503s busy (Retry-After: 30 — the raw wait only survives via the
// cap) before answering, or always-503 for the exhausted-retry contract
function busyStub(mode: "flaky" | "always", content: string) {
	let posts = 0;
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			await req.json().catch(() => ({}));
			posts++;
			if (mode === "always" || posts === 1)
				return new Response("busy", {
					status: 503,
					headers: { "retry-after": "30" },
				});
			return Response.json({ choices: [{ message: { content } }] });
		},
	});
	return {
		chat: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
		count: () => posts,
		stop: () => srv.stop(true),
	};
}

// the fork is seeded DIRECTLY into the fixture db (advise-panel.test.ts
// idiom — coord-emit + feed discovery proved flaky here)
function seedFork(note: string): number {
	const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4000");
	const ev = db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'busy-retry-test', 'NEED_DECISION', NULL, ?, 'busy-retry-lane')",
		)
		.run(Date.now(), JSON.stringify({ note }));
	db.close();
	return Number(ev.lastInsertRowid);
}

async function adviseOne(
	id: number,
	legEnv: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
	// async spawn: the stubs are in-process Bun.serve instances that must
	// answer DURING the child (W362)
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

function gdb(): Database {
	const d = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	d.run("PRAGMA busy_timeout = 4000");
	return d;
}

describe("advise busy-retry (W850)", () => {
	test("503 busy once → capped Retry-After wait → retry answers, advice fact lands", async () => {
		const stub = busyStub(
			"flaky",
			"RECOMMENDATION: retry won\nRATIONALE: second attempt\nRISK: none",
		);
		const id = seedFork("busy-retry success fork");
		try {
			const r = await adviseOne(id, {
				SUSPENDERS_LLM_URL: stub.chat,
				SUSPENDERS_LLM_MODEL: "stub-model",
				SUSPENDERS_ADVICE_RETRY_CAP_MS: "500",
			});
			expect(r.code).toBe(0);
			expect(stub.count()).toBe(2);
			expect(r.out).toContain("advised #");
			const db = gdb();
			const fact = db
				.query("SELECT value, source FROM facts WHERE key = ?")
				.get(`advice.${id}`) as { value: string; source: string } | null;
			expect(fact?.source).toBe("advise");
			const advice = JSON.parse(fact?.value ?? "{}") as { rec: string };
			expect(advice.rec).toBe("retry won");
			db.close();
		} finally {
			stub.stop();
		}
	});

	test("still busy after the one retry → honest error fact + exit 2", async () => {
		const stub = busyStub("always", "never");
		const id = seedFork("busy-retry exhausted fork");
		try {
			const r = await adviseOne(id, {
				SUSPENDERS_LLM_URL: stub.chat,
				SUSPENDERS_LLM_MODEL: "stub-model",
				SUSPENDERS_ADVICE_RETRY_CAP_MS: "500",
			});
			expect(r.code).toBe(2);
			expect(stub.count()).toBe(2);
			expect(r.err).toContain("503 busy");
			expect(r.err).toContain("one retry");
			const db = gdb();
			const errFact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${id}.error`) as { value: string } | null;
			expect(errFact?.value).toContain("503");
			db.close();
		} finally {
			stub.stop();
		}
	});
});
