// test/federation-report.test.ts — W171 federation phase 3 spoke side:
// rule extraction, the conjunctive opt-in gate, the no-names aggregate
// builder (names dropped at the SQL layer, private-domain aid rows
// excluded), and the cycle e2e against a live hub (reported + cursor;
// hub-down degrades with the cursor unmoved).
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	buildSelfReport,
	loadCursor,
	REPORT_CLASSES,
	runSelfReportCycle,
	saveCursor,
	selfReportGate,
	selfReportRule,
} from "../hooks/lib/federation-report.ts";
import { startServer } from "../../buckle/src/server.ts";
import { lastKnownPath, type FederationEnv } from "../hooks/lib/federation.ts";
import { atomicWrite } from "../hooks/lib/board-config.ts";
import { GROUPS } from "../hooks/lib/usage.ts";

const RULE = {
	id: "federation.self_report",
	data: { teams: ["platform", "gaps"] },
};

const KNOBS = { id: "gateway.knobs" };

function tmpEnv(): FederationEnv {
	const home = join(
		tmpdir(),
		`w171-spoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(home, { recursive: true });
	return { BUCKLE_SECRETS_HOME: home, HOME: home };
}

/** Scratch spoke ledger with the govdb shapes (subset of columns the
 *  builder reads). Two actors, three models — the aggregate must NOT name
 *  any of them. */
function seedDb(): Database {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE usage_rollup (
		hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL,
		model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0,
		out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0,
		cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (hour_bucket, actor, model))`);
	db.exec(`CREATE TABLE aid_rollup (
		hour_bucket INTEGER NOT NULL, aid TEXT NOT NULL, domain TEXT NOT NULL,
		model_group TEXT NOT NULL, injected INTEGER NOT NULL DEFAULT 0,
		skipped INTEGER NOT NULL DEFAULT 0, tok_injected INTEGER NOT NULL DEFAULT 0,
		est_tok_saved INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (hour_bucket, aid, domain, model_group))`);
	return db;
}

describe("self-report: rule + gate (default OFF)", () => {
	test("rule extraction: absent → null; present → teams", () => {
		expect(selfReportRule(null)).toBeNull();
		expect(selfReportRule({ rules: [KNOBS] })).toBeNull();
		expect(selfReportRule({ rules: [KNOBS, RULE] })).toEqual({
			teams: ["platform", "gaps"],
		});
	});

	test("gate: every missing piece skips honestly", () => {
		const man = { rules: [KNOBS, RULE] };
		expect(selfReportGate("", "http://h", "tok", man).go).toBe(false);
		expect(selfReportGate("platform", "", "tok", man).go).toBe(false);
		expect(selfReportGate("platform", "http://h", "", man).go).toBe(false);
		expect(selfReportGate("platform", "http://h", "tok", null).go).toBe(false);
		expect(
			selfReportGate("platform", "http://h", "tok", { rules: [KNOBS] }).go,
		).toBe(false);
		expect(selfReportGate("gaps", "http://h", "tok", man).go).toBe(true);
	});
});

describe("self-report: buildSelfReport drops names, excludes private aids", () => {
	test("aggregate by class across actors/models; no identity strings in payload", () => {
		const db = seedDb();
		const b = Math.floor(Date.now() / 3_600_000) * 3_600_000;
		const ins = db.prepare(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(b, "klaus@corp", "claude-fable-5-1", "flash", 100, 40, 2);
		ins.run(b, "agent-07", "glm-5.3-flash", "flash", 50, 10, 1);
		ins.run(b, "klaus@corp", "claude-opus-5-5", "full", 200, 90, 1);
		const aid = db.prepare(
			"INSERT INTO aid_rollup (hour_bucket, aid, domain, model_group, injected, skipped, tok_injected) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		aid.run(b, "lesson-recall", "knowledge", "flash", 3, 1, 900);
		aid.run(b, "internal-only", "private", "flash", 5, 2, 500);
		const payload = buildSelfReport(db, {
			team: "platform",
			sinceBucket: b - 1,
			untilBucket: b,
			nowMs: b + 3_600_000,
		});
		expect(payload.team).toBe("platform");
		expect(payload.windows).toHaveLength(1);
		const w = payload.windows[0];
		expect(w?.classes.flash?.in_tok).toBe(150);
		expect(w?.classes.flash?.out_tok).toBe(50);
		expect(w?.classes.flash?.requests).toBe(3);
		expect(w?.classes.full?.in_tok).toBe(200);
		expect(w?.aids).toHaveLength(1);
		expect(w?.aids[0]?.aid).toBe("lesson-recall");
		const flat = JSON.stringify(payload);
		expect(flat.includes("klaus@corp")).toBe(false);
		expect(flat.includes("agent-07")).toBe(false);
		expect(flat.includes("claude-fable-5-1")).toBe(false);
		expect(flat.includes("internal-only")).toBe(false);
		expect(flat.includes("private")).toBe(false);
		db.close();
	});

	test("REPORT_CLASSES mirrors the board GROUPS contract", () => {
		expect([...REPORT_CLASSES]).toEqual(GROUPS);
	});
});

const ROOT = "buckle-test-root";

/** Live opted-in hub for the cycle e2e (spoke creds minted via admin). */
async function startOptedInHub(): Promise<{
	base: string;
	stop: () => void;
	mint: (name: string) => Promise<string>;
}> {
	const dir = `/tmp/w171-cyc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  federation:",
		"    self_report:",
		"      teams: [platform]",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  local-swarm:",
		"    - url: http://127.0.0.1:8502",
		"      dialect: openai",
		"",
	].join("\n");
	await Bun.write(`${dir}.policy.yaml`, policy);
	await Bun.write(`${dir}.upstreams.yaml`, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.yaml`,
		upstreamsPath: `${dir}.upstreams.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	const base = `http://127.0.0.1:${String(srv.port)}`;
	const mint = async (name: string): Promise<string> => {
		const res = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({
				name,
				scopes: ["buckle:spoke:WRITE_", "buckle:spoke:READ_"],
			}),
		});
		return (await res.json()).key;
	};
	return { base, stop: () => srv.stop(true), mint };
}

describe("self-report: cycle e2e (live hub)", () => {
	test("opted-in spoke reports; hub stores; cursor advances", async () => {
		const env = tmpEnv();
		const hub = await startOptedInHub();
		try {
			const token = await hub.mint("spoke-w171");
			atomicWrite(
				lastKnownPath(env),
				JSON.stringify({
					pulled_at: new Date().toISOString(),
					hub_url: hub.base,
					manifest: { version: "fed-1", rules: [KNOBS, RULE], cr_queue: [] },
					entitlements: null,
				}),
			);
			const db = seedDb();
			const bucket = (Math.floor(Date.now() / 3_600_000) - 1) * 3_600_000;
			db.prepare(
				"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(bucket, "klaus@corp", "claude-fable-5-1", "flash", 100, 40, 2);
			const out = await runSelfReportCycle({
				env,
				hubUrl: hub.base,
				token,
				team: "platform",
				db,
			});
			expect(out.action).toBe("reported");
			expect(out.windows).toBe(1);
			expect(loadCursor(env)?.last_bucket).toBe(bucket);
			const got = await fetch(`${hub.base}/federation/usage?days=7`, {
				headers: { authorization: `Bearer ${ROOT}` },
			});
			const rep = (await got.json()) as {
				windows: Array<{ classes: Record<string, { in_tok: number }> }>;
			};
			expect(rep.windows[0]?.classes.flash?.in_tok).toBe(100);
			db.close();
		} finally {
			hub.stop();
		}
	});

	test("hub-down → degraded, cursor unmoved", async () => {
		const env = tmpEnv();
		atomicWrite(
			lastKnownPath(env),
			JSON.stringify({
				pulled_at: new Date().toISOString(),
				hub_url: "http://127.0.0.1:1",
				manifest: { version: "fed-1", rules: [KNOBS, RULE], cr_queue: [] },
				entitlements: null,
			}),
		);
		saveCursor(env, { last_bucket: 0, reported_at: new Date().toISOString() });
		const db = seedDb();
		const bucket = (Math.floor(Date.now() / 3_600_000) - 1) * 3_600_000;
		db.prepare(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(bucket, "klaus@corp", "claude-fable-5-1", "flash", 100, 40, 2);
		const out = await runSelfReportCycle({
			env,
			hubUrl: "http://127.0.0.1:1",
			token: "x",
			team: "platform",
			db,
		});
		expect(out.action).toBe("degraded");
		expect(loadCursor(env)?.last_bucket).toBe(0);
	});
});
