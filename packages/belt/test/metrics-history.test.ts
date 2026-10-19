import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child imports the real metrics.ts with HOME pointed at a fixture dir
// (METRICS_DB bakes process.env.HOME at module load), seeds real time-stamped
// routes rows, and reports the history payload — env-isolated from this
// process and from the operator's live metrics.db.
const CHILD = `
const { Database } = await import("bun:sqlite");
const m = await import(process.env.METRICS_MOD);
await m.metricsHistory(); // creates the schema in the fixture HOME
const db = new Database(m.METRICS_DB);
const now = Date.now();
const ins = db.query(
	"INSERT INTO routes (ts, machine, port, model, role, duration_ms, ok, err, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
ins.run(new Date(now - 120000).toISOString(), "mac", 8902, "m", "code", 120, 1, "", "t");
ins.run(new Date(now - 240000).toISOString(), "mac", 8902, "m", "code", 80, 0, "boom", "t");
ins.run(new Date(now - 600000).toISOString(), "nas", 4101, "x", "proxy", 300, 1, "", "t");
ins.run(new Date(now).toISOString(), "mac", 8903, "m", "reason", 200, 1, "", "t");
ins.run(new Date(now - 7 * 3600000).toISOString(), "old", 1, "y", "z", 5, 1, "", "t");
const h = await m.metricsHistory();
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(JSON.stringify({
	bucketMs: h.bucketMs,
	buckets: h.buckets.length,
	total: sum(h.buckets.map((b) => b[1])),
	errs: sum(h.buckets.map((b) => b[2])),
	gridOk: h.buckets.every((b) => b[0] % 300 === 0),
	nz: h.buckets.filter((b) => b[1] > 0),
	endpoints: h.endpoints,
}));
`;

test("metricsHistory buckets real samples onto a 5-minute grid", async () => {
	const home = mkdtempSync(join(tmpdir(), "belt-hist-"));
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	try {
		const child = Bun.spawnSync(
			[process.execPath, "-e", CHILD],
			{
				env: {
					...process.env,
					HOME: home,
					METRICS_MOD: join(import.meta.dir, "..", "bin", "metrics.ts"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.exitCode).toBe(0);
		const out = JSON.parse(child.stdout.toString());
		expect(out.bucketMs).toBe(300000);
		expect(out.buckets).toBe(72);
		expect(out.total).toBe(4); // the 7h-old row sits outside the 6h window
		// the current-bucket row must be visible immediately (grid anchored
		// to now — a route that just landed paints without waiting a step)
		expect(out.errs).toBe(1);
		expect(out.gridOk).toBe(true);
		expect(out.endpoints).toHaveLength(3);
		const mac = out.endpoints.find((e) => e.key === "mac:8902");
		const macReason = out.endpoints.find((e) => e.key === "mac:8903");
		const nas = out.endpoints.find((e) => e.key === "nas:4101");
		expect(mac.counts).toHaveLength(72);
		expect(mac.counts.reduce((a, b) => a + b, 0)).toBe(2);
		expect(macReason.counts.reduce((a, b) => a + b, 0)).toBe(1);
		expect(nas.counts.reduce((a, b) => a + b, 0)).toBe(1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
