// advise-gated.test.ts — W1119.1: the advise single-fork chain rides the ONE
// gated Buckle client. Pins: /v1/messages + Bearer bksk_ key + x-belt-hint
// "prefer local reasoning"; model preference stays DATA (settings pin, then
// SUSPENDERS_LLM_MODEL, else local-reason); real pt/ct ride the llm.call
// telemetry; a gate HTTP answer is a provider failure exit 2; an unreachable
// or unconfigured gate degrades exit 0 with the fork left open.

import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { boardFixture } from "./helpers/board-fixture.ts";

test.setTimeout(30_000);

const { HOME, REPO, env, bin } = await boardFixture(0, test.afterAll);

type Seen = {
	path: string;
	key: string | null;
	hint: string | null;
	body: Record<string, unknown>;
};

// the W1119.1 stub: one gate answering the anthropic wire, capture per hit;
// usage pins 11 in / 7 out so telemetry assertions can prove the real ride
function makeStub(content: string, status = 200) {
	const seen: Seen[] = [];
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const body = (await req.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			seen.push({
				path: url.pathname,
				key: req.headers.get("x-api-key"),
				hint: req.headers.get("x-belt-hint"),
				body,
			});
			if (status !== 200) return Response.json({ error: "busy" }, { status });
			return Response.json({
				model: "served-model",
				content: [{ type: "text", text: content }],
				usage: { input_tokens: 11, output_tokens: 7 },
			});
		},
	});
	return {
		seen,
		base: `http://127.0.0.1:${srv.port}`,
		stop: () => srv.stop(true),
	};
}

// fork seeded DIRECTLY into the fixture db (advise-panel.test.ts idiom)
function seedFork(note: string): number {
	const db = gdb();
	const ev = db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'gated-test', 'NEED_DECISION', NULL, ?, 'gated-lane')",
		)
		.run(Date.now(), JSON.stringify({ note }));
	db.close();
	return Number(ev.lastInsertRowid);
}

function gdb(): Database {
	const d = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	d.run("PRAGMA busy_timeout = 4000");
	return d;
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

test.describe("advise gated chain (W1119.1)", () => {
	test("rides the ONE gate: wire, scoped key, hint, data-model pin", async () => {
		const s = makeStub(
			"RECOMMENDATION: ride the gate.\nRATIONALE: one client owns the wire.\nRISK: gate outage leaves the fork open.",
		);
		const id = seedFork("gated wire fork");
		const r = await advise(id, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
			SUSPENDERS_LLM_MODEL: "pinned-advise",
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("advised #");
		const hit = s.seen[0] as Seen;
		expect(hit.path).toBe("/v1/messages");
		expect(hit.key).toBe("bksk_gated");
		expect(hit.hint).toBe("prefer local reasoning");
		expect(hit.body.model).toBe("pinned-advise");
	});

	test("model preference stays data — pin wins, default rides, no probe", async () => {
		const s = makeStub("RECOMMENDATION: pinned to data.\nVERDICT: approve");
		const a = seedFork("gated pin fork");
		const pinned = await advise(a, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
			SUSPENDERS_LLM_MODEL: "pinned-advise",
		});
		expect(pinned.code).toBe(0);
		const b = seedFork("gated default fork");
		const unPinned = await advise(b, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
		});
		expect(unPinned.code).toBe(0);
		expect(s.seen).toHaveLength(2);
		expect((s.seen[0] as Seen).body.model).toBe("pinned-advise");
		expect((s.seen[1] as Seen).body.model).toBe("local-reason");
	});

	test("real pt/ct ride the llm.call telemetry and the advice fact", async () => {
		const s = makeStub(
			"RECOMMENDATION: counted.\nRATIONALE: usage rides.\nRISK: none.",
		);
		const id = seedFork("gated telemetry fork");
		const r = await advise(id, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
		});
		expect(r.code).toBe(0);
		const db = gdb();
		const call = db
			.query(
				"SELECT payload FROM events WHERE kind = 'llm.call' ORDER BY id DESC LIMIT 1",
			)
			.get() as { payload: string };
		const usage = JSON.parse(call.payload) as {
			for: number;
			model: string;
			host: string;
			pt: number;
			ct: number;
			tt: number;
		};
		expect(usage.tt).toBe(18);
		expect(usage.for).toBe(id);
		expect(usage.model).toBe("served-model");
		// URL.host carries the ephemeral fixture port
		expect(usage.host).toMatch(/^buckle\(127\.0\.0\.1:\d+\)$/);
		expect(usage.pt).toBe(11);
		expect(usage.ct).toBe(7);
		const fact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}`) as { value: string };
		expect((JSON.parse(fact.value) as { model: string }).model).toBe(
			"served-model",
		);
		db.close();
	});

	test("dead gate degrades: exit 0, fork stays open, stamp cleared", async () => {
		const id = seedFork("gated dead fork");
		const r = await advise(id, {
			SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:1",
			SUSPENDERS_BUCKLE_TOKEN: "bksk_dead",
		});
		expect(r.code).toBe(0);
		expect(r.err).toContain("gate unavailable");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string };
		expect(errFact.value).toContain("unavailable:");
		expect(
			db.query("SELECT value FROM facts WHERE key = ?").get(`advice.${id}`),
		).toBeNull();
		expect(
			db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${id}.requested`),
		).toBeNull();
		db.close();
	});

	test("gate HTTP 503 is a provider failure: exit 2, honest error fact", async () => {
		const s = makeStub("busy", 503);
		const id = seedFork("gated http-reject fork");
		const r = await advise(id, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain("failed");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string };
		expect(errFact.value).toContain("buckle inference HTTP");
		expect(errFact.value).not.toContain("bksk_gated");
		db.close();
		s.stop();
	});

	test("gate answering empty content is an honest failure (W552.6.1): exit 2", async () => {
		const s = makeStub("   ");
		const id = seedFork("gated empty-answer fork");
		const r = await advise(id, {
			SUSPENDERS_BUCKLE_URL: s.base,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_gated",
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain("failed");
		const db = gdb();
		const errFact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${id}.error`) as { value: string };
		expect(errFact.value).toContain("advise gate returned no text");
		db.close();
		s.stop();
	});
});
