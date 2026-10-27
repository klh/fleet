import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "../../test-kit/src/index.ts";

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
ins.run(new Date(now - 1000).toISOString(), "mac", 8902, "m", "code", 90, 1, "", "t");
ins.run(new Date(now - 1000).toISOString(), "mac", 8902, "m2", "code", 90, 1, "", "t");
ins.run(new Date(now - 240000).toISOString(), "mac", 8902, "m", "code", 80, 0, "boom", "t");
ins.run(new Date(now - 600000).toISOString(), "nas", 4101, "x", "proxy", 300, 1, "", "t");
// legacy failRoute placeholder: failure with hard-coded duration_ms=0 — counts
// as a request + error, never as a latency sample
ins.run(new Date(now - 30000).toISOString(), "mac", 8902, "m", "code", 0, 0, "failRoute", "t");
ins.run(new Date(now - 7 * 3600000).toISOString(), "old", 1, "y", "z", 5, 1, "", "t");
const h = await m.metricsHistory();
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(JSON.stringify({
	bucketMs: h.bucketMs,
	buckets: h.buckets.length,
	lastBucket: h.buckets.at(-1)?.[0],
	currentStart: Math.floor(now / 300000) * 300,
	total: sum(h.buckets.map((b) => b[1])),
	errs: sum(h.buckets.map((b) => b[2])),
	measured: sum(h.buckets.map((b) => b[4])),
	unmeasuredNull: h.buckets.every((b) => b[1] === 0 || b[4] > 0 || b[3] === null),
	gridOk: h.buckets.every((b) => b[0] % 300 === 0),
	nz: h.buckets.filter((b) => b[1] > 0),
	endpoints: h.endpoints,
}));
`;

// Failure-only endpoint + machine-level merge: hard-coded zero-duration
// failures carry no latency — avg_ms goes null without samples and the
// merge re-averages by measured count, not call count.
const CHILD2 = `
const { Database } = await import("bun:sqlite");
const m = await import(process.env.METRICS_MOD);
await m.metricsHistory();
const db = new Database(m.METRICS_DB);
const now = Date.now();
const ins = db.query(
	"INSERT INTO routes (ts, machine, port, model, role, duration_ms, ok, err, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
for (let i = 0; i < 3; i++)
	ins.run(new Date(now - 60000).toISOString(), "mac", 8906, "g", "code", 0, 0, "failRoute", "t");
ins.run(new Date(now - 60000).toISOString(), "mac", 8902, "m", "code", 100, 1, "", "t");
ins.run(new Date(now - 60000).toISOString(), "mac", 8902, "m", "code", 200, 0, "boom", "t");
const snap = await m.metricsSnapshot();
console.log(JSON.stringify({
	fails: snap.endpoints["mac:8906:g"],
	measured: snap.endpoints["mac:8902:m"],
	merged: await m.metricsFor("mac"),
}));
`;

test("metricsHistory buckets real samples onto a 5-minute grid", async () => {
	const { home, env, clean } = scratchWorld({ prefix: "belt-hist-" });
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	try {
		const child = Bun.spawnSync([process.execPath, "-e", CHILD], {
			env: {
				...env,
				METRICS_MOD: join(import.meta.dir, "..", "bin", "metrics.ts"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		const out = JSON.parse(child.stdout.toString());
		expect(out.bucketMs).toBe(300000);
		expect(out.buckets).toBe(72);
		expect(out.lastBucket).toBe(out.currentStart);
		expect(out.total).toBe(6); // the 7h-old row sits outside the 6h window
		expect(out.errs).toBe(2);
		expect(out.measured).toBe(5); // the zero-duration failRoute row is not a sample
		expect(out.unmeasuredNull).toBe(true);
		expect(out.gridOk).toBe(true);
		expect(out.endpoints).toHaveLength(2);
		const mac = out.endpoints.find((e) => e.key === "mac:8902");
		const nas = out.endpoints.find((e) => e.key === "nas:4101");
		expect(mac.counts).toHaveLength(72);
		expect(mac.counts.reduce((a, b) => a + b, 0)).toBe(5);
		expect(mac.models).toEqual(["m", "m2"]);
		expect(nas.counts.reduce((a, b) => a + b, 0)).toBe(1);
	} finally {
		clean();
	}
});

test("zero-duration failures are unmeasured: null avg, measured-weighted merge", async () => {
	const { home, env, clean } = scratchWorld({ prefix: "belt-hist2-" });
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	try {
		const child = Bun.spawnSync([process.execPath, "-e", CHILD2], {
			env: {
				...env,
				METRICS_MOD: join(import.meta.dir, "..", "bin", "metrics.ts"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		const out = JSON.parse(child.stdout.toString());
		expect(out.fails.calls).toBe(3);
		expect(out.fails.errors).toBe(3);
		expect(out.fails.measured).toBe(0);
		expect(out.fails.avg_ms).toBeNull();
		expect(out.measured.calls).toBe(2);
		expect(out.measured.measured).toBe(2);
		expect(out.measured.avg_ms).toBe(150);
		// merge weights by the 2 measured samples (150ms), not 5 calls (60ms) —
		// the failure-only endpoint carries no latency
		expect(out.merged.calls).toBe(5);
		expect(out.merged.errors).toBe(4);
		expect(out.merged.measured).toBe(2);
		expect(out.merged.avg_ms).toBe(150);
	} finally {
		clean();
	}
});
