import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { buildUsageReport } from "../hooks/lib/usage/usage.ts";
import { usagePage } from "../hooks/bin/usage-page-html.ts";

test("demo provenance is excluded across series; names never hide real traffic", () => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE sessions (sid TEXT, actor TEXT, role TEXT, project TEXT, started_at INTEGER, tags TEXT)",
	);
	db.run(
		"CREATE TABLE usage_rollup (hour_bucket INTEGER, actor TEXT, model TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER)",
	);
	const now = 3_600_000 * 1000;
	const sessions = db.query("INSERT INTO sessions VALUES (?, ?, ?, ?, 1, ?)");
	sessions.run("seed", "synthetic", "demo", "demo:usage", '{"team":"fake"}');
	sessions.run("real", "demo:real-person", "dev", "project", '{"team":"real"}');
	sessions.run("mixed-seed", "mixed", "demo", "demo:usage", "{}");
	sessions.run("mixed-real", "mixed", "dev", "project", "{}");
	for (const [actor, tokens] of [
		["synthetic", 9000],
		["demo:real-person", 100],
		["mixed", 200],
	]) {
		db.query(
			"INSERT INTO usage_rollup VALUES (?, ?, 'm', 'flash', ?, 0, 0, 0, 1)",
		).run(now, actor, tokens);
	}
	const real = buildUsageReport(db, { nowMs: now, days: 1 });
	expect(real.totals.tok).toBe(300);
	expect(real.actors.map((a) => a.actor)).toEqual([
		"mixed",
		"demo:real-person",
	]);
	expect(real.timeline.at(-1)?.groups.flash).toBe(300);
	expect(real.byHour.reduce((n, x) => n + x.tokens, 0)).toBe(300);
	expect(real.facets.teams).toEqual(["real"]);
	expect(real.demo).toEqual({ included: false, excludedActors: 1 });
	const demo = buildUsageReport(db, { nowMs: now, days: 1, includeDemo: true });
	expect(demo.totals.tok).toBe(9300);
	expect(demo.actors[0].demo).toBe(true);
	const page = usagePage(demo, { days: 1, team: "fake", includeDemo: true });
	expect(page).toContain("Synthetic demo usage included");
	expect(page).toContain("includeDemo=true");
	// W652.3.1: the demo badge rides the payload actor row (Lit renders it)
	const panels = JSON.parse(
		page.match(
			/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
		)?.[1] ?? "{}",
	) as { panels: { actors: { rows: { actor: string; demo: boolean }[] } } };
	expect(
		panels.panels.actors.rows.find((row) => row.actor === "synthetic")?.demo,
	).toBe(true);
	db.close();
});
