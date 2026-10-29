// done-broadcast.e2e.ts (ported from W2187 done-broadcast.test.ts, W1294 law) — W822.1: the work CLI's done handler broadcasts a
// kev-scored condensed summary. Store-side assertions run in a temp-HOME
// subprocess (coord-reads recipe); the kev leg is an in-process stub so the
// labeled path is exercised without the real :8912 box.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	condenseDoneNote,
	KEV_LABELS,
	kevRelevance,
} from "../hooks/lib/done-broadcast.ts";

const DONE_BC = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"done-broadcast.ts",
);
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-done-broadcast-test-"));

test.afterAll(() => rmSync(home, { recursive: true, force: true }));

const runIn = (code: string, env: Record<string, string> = {}): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(
			`spawn failed (${p.exitCode}): ${new TextDecoder().decode(p.stderr).slice(0, 400)} | out: ${new TextDecoder().decode(p.stdout).slice(0, 200)}`,
		);
	const raw = new TextDecoder().decode(p.stdout);
	return raw.trim();
};

test.describe("@unit condenseDoneNote", () => {
	test("headline = title + short sha, summary joined", async () => {
		const n = await condenseDoneNote({
			title: "land the thing",
			summary: "did it",
			sha: "abcd1234567890ef",
		});
		expect(n.startsWith("done: land the thing @abcd1234")).toBe(true);
		expect(n).toContain("did it");
	});
	test("long input caps at the headline budget, ellipsis-terminated", async () => {
		const n = await condenseDoneNote({
			title: "t",
			summary: "x".repeat(600),
			description: "y".repeat(600),
		});
		expect(n.length).toBeLessThanOrEqual(280);
		expect(n.endsWith("…")).toBe(true);
	});
	test("title-only survives (no summary, no description)", async () => {
		const n = await condenseDoneNote({ title: "solo" });
		expect(n).toBe("done: solo");
	});
	test("kev label vocabulary is exactly the three tiers", () => {
		expect([...KEV_LABELS]).toEqual(["actionable-now", "interesting", "noise"]);
	});
});

test.describe("@unit kevRelevance", () => {
	test("labels via systemone; kev down fails open to interesting", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					model: "stub",
					answers: {
						d: {
							type: "choice",
							choice: "actionable-now",
							confidence: 0.9,
							probabilities: {
								"actionable-now": 0.9,
								interesting: 0.1,
								noise: 0,
							},
						},
					},
					usage: { input_tokens: 1, output_tokens: 1 },
					latency_ms: 1,
				}),
		});
		const port = (server as unknown as { port: number }).port;
		const prev = process.env.SUSPENDERS_KEV_URL;
		process.env.SUSPENDERS_KEV_URL = `http://127.0.0.1:${port}`;
		try {
			expect(await kevRelevance("done: x @y — z")).toBe("actionable-now");
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_KEV_URL;
			else process.env.SUSPENDERS_KEV_URL = prev;
			server.stop(true);
		}
		const down = runIn(
			`
const m = await import(${JSON.stringify(DONE_BC)});
console.log(await m.kevRelevance("done: x @y — z"));`,
			{ SUSPENDERS_KEV_URL: "http://127.0.0.1:1" },
		);
		expect(down).toBe("interesting");
	});
});

test.describe("@unit emitDoneBroadcast (temp-HOME subprocess)", () => {
	const emitScript = () => `
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const m = await import(${JSON.stringify(DONE_BC)});
const db = openGovernorDb();
const now = Date.now();
db.query("INSERT OR IGNORE INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES ('peer-lane', 'p', 'worker', NULL, NULL, ?, ?, 'RUNNING')").run(now, now);
const r = await m.emitDoneBroadcast(db, { id: "W9", title: "land the thing", sha: "abcd1234567890", summary: "did it", source: "tester", now });
const evs = db.query("SELECT target, payload FROM events WHERE kind = 'BROADCAST'").all();
const latest = db.query("SELECT value FROM facts WHERE key = 'broadcast.latest'").get();
console.log(JSON.stringify({ r, evs, latest: latest ? JSON.parse(latest.value) : null }));
`;
	test("guards: hub deploy + kill switch emit nothing", () => {
		const hub = JSON.parse(
			runIn(
				`
const m = await import(${JSON.stringify(DONE_BC)});
console.log(JSON.stringify(await m.emitDoneBroadcast(null, { id: "W1", title: "t" })));`,
				{ KLH_HUB_NAME: "nas" },
			),
		);
		expect(hub).toBeNull(); // hub deploys emit nothing
		const off = JSON.parse(
			runIn(
				`
const m = await import(${JSON.stringify(DONE_BC)});
console.log(JSON.stringify(await m.emitDoneBroadcast(null, { id: "W1", title: "t" })));`,
				{ SUSPENDERS_DONE_BROADCAST: "0" },
			),
		);
		expect(off).toBeNull();
	});
	test("live lane gets a kev-labeled BROADCAST row + broadcast.latest fact", () => {
		const out = JSON.parse(
			runIn(emitScript(), { SUSPENDERS_KEV_URL: "http://127.0.0.1:1" }),
		);
		expect(out.r.label).toBe("interesting"); // kev dead-pinned — fail-open
		expect(out.r.targets).toBe(1);
		expect(out.evs).toHaveLength(1);
		expect(out.evs[0].target).toBe("peer-lane");
		expect(JSON.parse(out.evs[0].payload).kev).toBe("interesting");
		expect(out.latest.kev).toBe("interesting");
	});
	test("re-done of the same summary dedupes inside the 24h window", () => {
		const out = JSON.parse(
			runIn(emitScript(), { SUSPENDERS_KEV_URL: "http://127.0.0.1:1" }),
		);
		expect(out.r.deduped).toBe(true);
		expect(out.r.targets).toBe(0);
	});
	test("a throwing store never fails the broadcast (total function)", () => {
		const out = JSON.parse(
			runIn(
				`
const m = await import(${JSON.stringify(DONE_BC)});
console.log(JSON.stringify(await m.emitDoneBroadcast({
	query: () => {
		throw new Error("boom");
	},
}, { id: "W1", title: "t" })));`,
			) as string,
		);
		expect(out).toBeNull();
	});
});
