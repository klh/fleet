import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, afterAll);
test("usage HTTP API defaults to real provenance; explicit opt-in includes seeds", async () => {
	const db = new Database(join(f.HOME, ".cache/claude-governor/governor.db"));
	try {
		const now = Date.now();
		const hour = Math.floor(now / 3_600_000) * 3_600_000;
		db.query(
			"INSERT INTO sessions(sid, actor, role, project, started_at, hb, state, tags) VALUES ('synthetic', 'synthetic', 'demo', 'demo:usage', ?, ?, 'CLOSED', '{}')",
		).run(now, now);
		db.query(
			"INSERT INTO sessions(sid, actor, role, project, started_at, hb, state, tags) VALUES ('real-actor', 'demo:real-person', 'dev', ?, ?, ?, 'CLOSED', '{}')",
		).run(f.MY_PROJ, now, now);
		for (const [actor, tokens] of [
			["synthetic", 9000],
			["demo:real-person", 100],
		]) {
			db.query(
				"INSERT INTO usage_rollup(hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, 'm', 'flash', ?, 0, 0, 0, 1)",
			).run(hour, actor, tokens);
		}
		const real = await (await fetch(`${f.BASE}/api/usage?days=1`)).json();
		expect(real.report.totals.tok).toBe(100);
		expect(real.report.actors.map((a: { actor: string }) => a.actor)).toEqual([
			"demo:real-person",
		]);
		const combined = await (
			await fetch(`${f.BASE}/api/usage?days=1&includeDemo=true`)
		).json();
		expect(combined.report.totals.tok).toBe(9100);
		expect(combined.report.demo.included).toBe(true);
		const typo = await (
			await fetch(`${f.BASE}/api/usage?includeDemo=yes`)
		).json();
		expect(typo.report.demo.included).toBe(false);
	} finally {
		db.close();
	}
});
