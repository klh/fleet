// belt-chat.test.ts — W552.6.1: the shared governed-gateway chat leg.
// Placeholder/empty belt replies validate to null (never an answer); the
// advise.ts child then degrades to the direct SUSPENDERS_LLM_URL leg, and a
// provider returning no content is an honest failure (exit 2), not a stored
// empty advice fact.
import { afterAll, setDefaultTimeout, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { beltChat } from "../hooks/lib/belt-chat.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000);

const { HOME, REPO, env, bin, run } = await boardFixture(0, afterAll);

// ─── beltChat unit: reply validation at the seam ───
describe("beltChat final-text validation", () => {
	const priorBelt = process.env.SUSPENDERS_BELT_URL;
	const withBelt = async (
		reply: unknown,
		status = 200,
		run?: (body: Record<string, unknown>) => void,
	) => {
		let seen: Record<string, unknown> | null = null;
		const mock = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				seen = (await req.json()) as Record<string, unknown>;
				return Response.json(reply, { status });
			},
		});
		process.env.SUSPENDERS_BELT_URL = `http://127.0.0.1:${mock.port}`;
		try {
			const r = await beltChat({ user: "w552 probe" });
			if (seen && run) run(seen);
			return r;
		} finally {
			mock.stop(true);
			if (priorBelt === undefined) delete process.env.SUSPENDERS_BELT_URL;
			else process.env.SUSPENDERS_BELT_URL = priorBelt;
		}
	};

	test("the belt placeholder is NOT an answer — validates to null", async () => {
		let body: Record<string, unknown> | null = null;
		const r = await withBelt({ reply: "(empty response)" }, 200, (b) => {
			body = b;
		});
		expect(r).toBeNull();
		expect(body?.execute).toBe(true);
		expect(body?.role).toBe("reasoning");
	});

	test("empty string reply validates to null", async () => {
		expect(await withBelt({ reply: "   " })).toBeNull();
	});

	test("a real reply passes through trimmed, with target metadata", async () => {
		const r = await withBelt({
			reply: "  RECOMMENDATION: go  \nRATIONALE: fine",
			target: { model: "glm-5.3-flash", machine: "mac" },
			ms: 7,
		});
		expect(r?.text).toBe("RECOMMENDATION: go  \nRATIONALE: fine");
		expect(r?.model).toBe("glm-5.3-flash");
		expect(r?.host).toBe("belt(mac)");
		expect(r?.ms).toBe(7);
	});

	test("belt erroring degrades to null (never throws)", async () => {
		expect(await withBelt({ error: "no healthy fit" }, 503)).toBeNull();
	});
});

// ─── advise.ts child: belt placeholder → direct leg, provider error stays ───
describe("advise placeholder fallback (W552.6.1)", () => {
	test("belt placeholder → direct leg answers; fact carries the real rec", async () => {
		expect(
			run("coord.ts", ["bootstrap", "--as", "w552-lane", "--role", "worker"])
				.code,
		).toBe(0);
		expect(
			run("coord.ts", [
				"emit",
				"need-decision",
				"--to",
				"w552-lane",
				"--note",
				"placeholder fallback probe",
				"--as",
				"w552-lane",
			]).code,
		).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'need-decision' AND json_extract(payload, '$.note') = 'placeholder fallback probe'",
			)
			.get() as { id: number };
		expect(ev?.id).toBeDefined();

		let beltHits = 0;
		const belt = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				beltHits++;
				return Response.json({ reply: "(empty response)" });
			},
		});
		const direct = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					choices: [
						{
							message: {
								content:
									"RECOMMENDATION: real answer from the direct leg\nRATIONALE: it works\nRISK: bounded",
							},
						},
					],
				}),
		});
		try {
			const child = Bun.spawn(["bun", join(bin, "advise.ts"), String(ev.id)], {
				cwd: REPO,
				env: {
					...env,
					SUSPENDERS_BELT_URL: `http://127.0.0.1:${belt.port}`,
					SUSPENDERS_LLM_URL: `http://127.0.0.1:${direct.port}/v1/chat/completions`,
					SUSPENDERS_LLM_MODEL: "fixture",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, out] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
			]);
			expect(code).toBe(0);
			expect(out).toContain("advised");
			expect(beltHits).toBe(1); // belt leg attempted, rejected the placeholder
			const fact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${ev.id}`) as { value: string };
			expect(JSON.parse(fact.value).rec).toBe(
				"real answer from the direct leg",
			);
			// the placeholder error fact must NOT exist — the direct leg won
			expect(
				db
					.query("SELECT value FROM facts WHERE key = ?")
					.get(`advice.${ev.id}.error`),
			).toBeNull();
		} finally {
			belt.stop(true);
			direct.stop(true);
			db.close();
		}
	});

	test("direct leg returning no content is an honest failure (exit 2 + error fact)", async () => {
		expect(
			run("coord.ts", [
				"emit",
				"need-decision",
				"--to",
				"w552-lane",
				"--note",
				"no-content failure probe",
				"--as",
				"w552-lane",
			]).code,
		).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'need-decision' AND json_extract(payload, '$.note') = 'no-content failure probe'",
			)
			.get() as { id: number };
		expect(ev?.id).toBeDefined();

		const belt = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ reply: "(empty response)" }),
		});
		const direct = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ choices: [{ message: { content: "" } }] }),
		});
		try {
			const child = Bun.spawn(["bun", join(bin, "advise.ts"), String(ev.id)], {
				cwd: REPO,
				env: {
					...env,
					SUSPENDERS_BELT_URL: `http://127.0.0.1:${belt.port}`,
					SUSPENDERS_LLM_URL: `http://127.0.0.1:${direct.port}/v1/chat/completions`,
					SUSPENDERS_LLM_MODEL: "fixture",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, err] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(2);
			expect(err).toContain("LLM answered with no content");
			const errorFact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${ev.id}.error`) as { value: string } | null;
			expect(errorFact?.value).toContain("LLM answered with no content");
		} finally {
			belt.stop(true);
			direct.stop(true);
			db.close();
		}
	});
});
