// advise-panel.test.ts — W742.2: the board advisory card renders panel
// verdicts + agreement. Pins: advise.ts --panel fans BOTH oracle legs via
// the shared legs lib, the advice fact carries {consensus, legs[]}, the
// W667 stamp clears on landing, the feed record rides advice.panel, and the
// client chunk renders the panel block (esc-assembled) with honest degraded
// legs. Total-miss degrade pins live in the W667 dedupe test (dead upstreams
// now ride the panel path via the board route).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createContext, runInContext } from "node:vm";
import { boardFixture } from "./helpers/board-fixture.ts";
import { CORE } from "../hooks/board-html/core.ts";
import { DECISIONS } from "../hooks/board-html/decisions.ts";

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
		const local = makeStub("Local read.\nVERDICT: approve");
		const cloud = makeStub("Cloud read.\nVERDICT: hold - quota risk");
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
			expect(advice.rec).toBe("Local read.");
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
});

describe("panel render chunk (W742.2)", () => {
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
