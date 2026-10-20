// advise-panel.test.ts — W742.2: the board advisory card renders panel
// verdicts + agreement. Pins: advise.ts --panel fans BOTH oracle legs via
// the shared legs lib, the advice fact carries {consensus, legs[]}, the
// W667 stamp clears on landing, the feed record rides advice.panel, and the
// client chunk renders the panel block (esc-assembled) with honest degraded
// legs. Total-miss degrade pins live in the W667 dedupe test (dead upstreams
// now ride the panel path via the board route).

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CORE } from "../hooks/board-html/core.ts";
import { DECISIONS } from "../hooks/board-html/decisions.ts";
import {
	recommendationOf,
	usableRecommendation,
} from "../hooks/lib/advice-quality.ts";
import { consensusOf } from "../hooks/lib/oracle-legs.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000);

const { HOME, REPO, env, bin, getDecisions, fork, sleep } = await boardFixture(
	0,
	afterAll,
);

// one stub answers both wires: /v1/messages → anthropic, else OpenAI chat
// (same pattern as oracle.test.ts — each panel leg gets its own stub)
function makeStub(content: string) {
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			await req.json().catch(() => ({}));
			const reply = url.pathname.endsWith("/v1/messages")
				? { content: [{ text: content }] }
				: { choices: [{ message: { content } }] };
			return Response.json(reply);
		},
	});
	return {
		base: `http://127.0.0.1:${srv.port}`,
		chat: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
		stop: () => srv.stop(true),
	};
}

// coord-emit + feed discovery proved flaky in this environment (clean-base
// A/B: 9/9 fail at fork() — pre-existing), so the fork is seeded DIRECTLY
// into the fixture db (decision-project-scope.test.ts idiom); the board's
// /api/decisions serves seeded rows fine.
function seedFork(note: string): Record<string, unknown> {
	const db = gdb();
	const ev = db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'panel-test', 'NEED_DECISION', NULL, ?, 'panel-lane')",
		)
		.run(Date.now(), JSON.stringify({ note }));
	db.query(
		"INSERT INTO decisions (event_id, target, asked_by, project, question, state, created_at) VALUES (?, 'panel-lane', 'panel-lane', ?, ?, 'OPEN', ?)",
	).run(ev.lastInsertRowid, REPO, note, Date.now());
	db.close();
	return { id: Number(ev.lastInsertRowid) };
}

async function advisePanel(
	id: number,
	legEnv: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
	// async spawn: spawnSync blocks the event loop, and the leg stubs are
	// in-process Bun.serve instances that must answer DURING the child (W362)
	const child = Bun.spawn(["bun", `${bin}/advise.ts`, String(id), "--panel"], {
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

describe("advise --panel (W742.2)", () => {
	test("fans both legs; fact carries verdicts + consensus; stamp clears; feed rides it", async () => {
		const local = makeStub(
			"RECOMMENDATION: Proceed with the local change.\nVERDICT: approve",
		);
		const cloud = makeStub(
			"RECOMMENDATION: Hold until quota is verified.\nVERDICT: hold - quota risk",
		);
		const rec = seedFork("panel fan-out fork");
		try {
			const r = await advisePanel(rec.id as number, {
				ORACLE_ROUTE_URL: local.chat,
				BELT_ESCALATE_URL: `${cloud.base}/v1/messages`,
				BELT_ESCALATE_KEY: "k",
			});
			expect(r.code).toBe(0);
			expect(r.out).toContain("panel: split approve vs hold");
			const db = gdb();
			const fact = db
				.query("SELECT value, source FROM facts WHERE key = ?")
				.get(`advice.${rec.id}`) as { value: string; source: string } | null;
			expect(fact?.source).toBe("advise");
			const advice = JSON.parse(fact?.value ?? "{}") as {
				rec: string;
				panel: {
					consensus: string;
					legs: {
						name: string;
						ok: boolean;
						verdict: string | null;
						ms: number;
					}[];
				};
			};
			expect(advice.panel.consensus).toBe("split approve vs hold");
			expect(advice.panel.legs).toHaveLength(2);
			expect(advice.panel.legs[0]?.name).toBe("local-reason");
			expect(advice.panel.legs[0]?.verdict).toBe("approve");
			expect(advice.panel.legs[1]?.name).toBe("cloud");
			expect(advice.panel.legs[1]?.verdict).toBe("hold");
			// primary = first answered leg; the card's use-fill keeps its contract
			expect(advice.rec).toBe("Proceed with the local change.");
			const stamp = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${rec.id}.requested`) as { value: string } | null;
			expect(stamp).toBeNull();
			db.close();
			// the decisions feed record rides advice.panel for the card (W663:
			// the feed cache may predate the seed — poll until it shows)
			let shown: Record<string, unknown> | undefined;
			for (let i = 0; i < 40 && !shown; i++) {
				shown = fork(await getDecisions(), "panel fan-out fork");
				if (!shown) await sleep(500);
			}
			expect(shown).toBeDefined();
			const adv = shown?.advice as { panel?: { consensus: string } };
			expect(adv.panel?.consensus).toBe("split approve vs hold");
		} finally {
			local.stop();
			cloud.stop();
		}
	});

	test("total miss: error fact + requested stamp cleared (W667), exit 0", async () => {
		const rec = seedFork("panel dead-upstream fork");
		const r = await advisePanel(rec.id as number, {
			ORACLE_ROUTE_URL: "http://127.0.0.1:1/v1/chat/completions",
			BELT_ESCALATE_URL: "http://127.0.0.1:1/v1/messages",
			BELT_ESCALATE_KEY: "k",
		});
		expect(r.code).toBe(0);
		expect(r.err).toContain("panel failed");
		const db = gdb();
		const err = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${rec.id}.error`) as { value: string } | null;
		expect(err?.value).toContain("local-reason:");
		const stamp = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${rec.id}.requested`) as { value: string } | null;
		expect(stamp).toBeNull();
		db.close();
	});

	test("total miss falls back to governed Belt advice and retains leg errors", async () => {
		const cloud = makeStub("");
		const belt = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					reply:
						"RECOMMENDATION: Ask the owner to review the stale fork.\nRATIONALE: The original legs did not answer.\nRISK: The owner must verify the linked work.",
					target: { model: "fallback-model", machine: "test" },
					ms: 12,
				}),
		});
		const rec = seedFork("panel fallback fork");
		try {
			const r = await advisePanel(rec.id as number, {
				ORACLE_ROUTE_URL: "http://127.0.0.1:1/v1/chat/completions",
				BELT_ESCALATE_URL: `${cloud.base}/v1/messages`,
				BELT_ESCALATE_KEY: "k",
				SUSPENDERS_BELT_URL: `http://127.0.0.1:${belt.port}`,
			});
			expect(r.code).toBe(0);
			const db = gdb();
			const fact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${rec.id}`) as { value: string } | null;
			const advice = JSON.parse(fact?.value ?? "{}") as {
				rec: string;
				panel: { consensus: string; legs: { error?: string }[] };
			};
			expect(advice.rec).toBe("Ask the owner to review the stale fork.");
			expect(advice.panel.consensus).toBe("degraded: governed route");
			expect(advice.panel.legs[0]?.error).toBeTruthy();
			expect(advice.panel.legs[1]?.error).toBeTruthy();
			expect(
				db
					.query("SELECT value FROM facts WHERE key = ?")
					.get(`advice.${rec.id}.error`),
			).toBeNull();
			db.close();
		} finally {
			cloud.stop();
			belt.stop(true);
		}
	});

	test("heading-only local reply and unavailable cloud leave no advice to use", async () => {
		const local = makeStub(
			"**Analysis of W849 State Degradation**\nVERDICT: approve",
		);
		const rec = seedFork("heading-only advice fork");
		try {
			const r = await advisePanel(rec.id as number, {
				ORACLE_ROUTE_URL: local.chat,
				BELT_ESCALATE_URL: "http://127.0.0.1:1/v1/messages",
				BELT_ESCALATE_KEY: "k",
			});
			expect(r.err).toContain("panel failed");
			const db = gdb();
			expect(
				db
					.query("SELECT value FROM facts WHERE key = ?")
					.get(`advice.${rec.id}`),
			).toBeNull();
			expect(
				db
					.query("SELECT value FROM facts WHERE key = ?")
					.get(`advice.${rec.id}.error`),
			).toBeTruthy();
			db.close();
		} finally {
			local.stop();
		}
	});

	test("one usable leg is shown as a single review", async () => {
		const local = makeStub(
			"RECOMMENDATION: Reopen W849 after validating the receipt.\nVERDICT: approve",
		);
		const rec = seedFork("one leg fork");
		try {
			const r = await advisePanel(rec.id as number, {
				ORACLE_ROUTE_URL: local.chat,
				BELT_ESCALATE_URL: "http://127.0.0.1:1/v1/messages",
				BELT_ESCALATE_KEY: "k",
			});
			expect(r.code).toBe(0);
			const db = gdb();
			const fact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${rec.id}`) as { value: string };
			const advice = JSON.parse(fact.value) as {
				rec: string;
				panel: { consensus: string };
			};
			expect(advice.rec).toBe("Reopen W849 after validating the receipt.");
			expect(advice.panel.consensus).toBe("single review: approve");
			db.close();
		} finally {
			local.stop();
		}
	});
});

describe("advice quality", () => {
	test("heading-only model output cannot become the answer", () => {
		expect(
			recommendationOf(
				"**Analysis of W849 State Degradation**\nVERDICT: approve",
			),
		).toBeNull();
		expect(usableRecommendation("**Analysis of W849 State Degradation**")).toBe(
			false,
		);
		expect(
			recommendationOf(
				"RECOMMENDATION: Reopen W849 and verify its receipt.\nVERDICT: hold",
			),
		).toBe("Reopen W849 and verify its receipt.");
	});

	test("one healthy panel leg is a single review", () => {
		expect(
			consensusOf([
				{
					name: "local-reason",
					ok: true,
					model: "m",
					ms: 1,
					verdict: "approve",
					text: "",
				},
				{
					name: "cloud",
					ok: false,
					model: "cloud",
					ms: 0,
					verdict: null,
					text: "",
					error: "unavailable",
				},
			]),
		).toBe("single review: approve");
	});
});

describe("panel render chunk (W742.2)", () => {
	test("transport retry budget advances across scheduled requests", () => {
		const ctx = createContext({});
		runInContext(CORE + DECISIONS, ctx);
		runInContext(
			"var advRetry = {}, advAttempts = {}, advising = {7: Date.now()}, advErr = {};",
			ctx,
		);
		for (let n = 1; n <= 3; n++) {
			runInContext("queueAdvRetry(7, 'transport failed')", ctx);
			expect(runInContext("advRetry[7].n", ctx)).toBe(n);
			runInContext("delete advRetry[7]", ctx);
		}
		runInContext("queueAdvRetry(7, 'transport failed')", ctx);
		expect(runInContext("advRetry[7]", ctx)).toBeUndefined();
		expect(runInContext("advErr[7]", ctx)).toBe("transport failed");
	});
	test("legacy heading cannot be copied to a decision", () => {
		const ctx = createContext({});
		runInContext(CORE + DECISIONS, ctx);
		expect(
			runInContext(`usableRec("**Analysis of W849 State Degradation**")`, ctx),
		).toBe(false);
	});
	test("panelHtml renders consensus + legs, escapes leg errors", () => {
		const ctx = createContext({});
		runInContext(CORE + DECISIONS, ctx);
		const panel = {
			consensus: "split approve vs hold",
			legs: [
				{
					name: "local-reason",
					ok: true,
					model: "m",
					verdict: "approve",
					ms: 2612,
				},
				{
					name: "cloud",
					ok: false,
					model: "cloud",
					verdict: null,
					ms: 0,
					error: "no cloud leg — <script>alert(1)</script>",
				},
			],
		};
		const html = runInContext(
			`panelHtml(${JSON.stringify(panel)})`,
			ctx,
		) as string;
		expect(html).toContain('class="pconsensus psplit"');
		expect(html).toContain("split approve vs hold");
		expect(html).toContain("local-reason (m) 2612ms — APPROVE");
		expect(html).toContain("UNAVAILABLE");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
});
