import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "../../test-kit/src/index.ts";

const CHILD = `
const { Database } = await import("bun:sqlite");
const { writeFileSync } = await import("node:fs");
const path = process.env.HOME + "/.claude-insights/swarm-routing.log";
const ts = new Date().toISOString();
const rows = [
  { ts, event: "upstream_attempt", port: 8912, status: 200, duration_ms: 5 },
  { ts, event: "upstream_attempt", port: 4100, status: 429, duration_ms: 10 },
  { ts, event: "request_completed", port: 8902, model: "final", category: "extract", duration_ms: 100 },
  { ts, event: "upstream_attempt", port: 4100, status: 502, duration_ms: 12 },
  { ts, event: "request_completed", port: 8902, model: "failed", category: "extract", duration_ms: 120, outcome: "empty" },
  { ts, event: "request_completed", port: 0, model: "arithmetic", duration_ms: 1, outcome: "in_process" },
  { ts, port: 8902, model: "legacy", category: "extract", duration_ms: 80 },
  { ts, port: 8902, model: "legacy-failed", category: "extract", duration_ms: 90, outcome: "empty" },
  { ts, port: 8902, model: "legacy-explicit-failed", category: "extract", duration_ms: 90, ok: false },
];
writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\\n") + "\\n");
if (process.env.SEED_OLD === "1") {
  const db = new Database(process.env.HOME + "/.claude/local-llm/metrics.db");
  db.run("CREATE TABLE routes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, machine TEXT NOT NULL, port INTEGER NOT NULL, model TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, err TEXT NOT NULL DEFAULT '', source TEXT NOT NULL)");
  db.run("CREATE TABLE cursors (path TEXT PRIMARY KEY, pos INTEGER NOT NULL DEFAULT 0)");
  db.run("INSERT INTO routes (ts, machine, port, model, role, duration_ms, ok, err, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [ts, "old", 4100, "", "", 10, 1, "", "swarm"]);
  db.run("INSERT INTO cursors (path, pos) VALUES (?, ?)", [path, 100]);
  db.close();
}
const m = await import(process.env.METRICS_MOD);
m.tallyMetrics();
const db = new Database(m.METRICS_DB);
const routes = db.query("SELECT port, model, ok FROM routes WHERE source = 'swarm' ORDER BY id").all();
console.log(JSON.stringify(routes));
`;

for (const seedOld of [false, true]) {
	test(`swarm metrics ingest completed outcomes and legacy rows, not attempts (${seedOld ? "old DB" : "new DB"})`, () => {
		const { home, env, clean } = scratchWorld({
			prefix: "belt-metrics-events-",
		});
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		mkdirSync(join(home, ".claude-insights"), { recursive: true });
		try {
			const child = Bun.spawnSync([process.execPath, "-e", CHILD], {
				env: {
					...env,
					METRICS_MOD: join(import.meta.dir, "..", "bin", "metrics.ts"),
					SEED_OLD: seedOld ? "1" : "0",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			expect(JSON.parse(child.stdout.toString())).toEqual([
				{ port: 8902, model: "final", ok: 1 },
				{ port: 8902, model: "failed", ok: 0 },
				{ port: 0, model: "arithmetic", ok: 1 },
				{ port: 8902, model: "legacy", ok: 1 },
				{ port: 8902, model: "legacy-failed", ok: 0 },
				{ port: 8902, model: "legacy-explicit-failed", ok: 0 },
			]);
		} finally {
			clean();
		}
	});
}
