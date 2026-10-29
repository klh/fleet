// test/quota-sweep-limit-class.e2e.ts — fork E: a Z.ai 1302 "Rate limit
// reached for requests" tail is concurrency pressure, NOT a quota wall: the
// dead lane reclaims with reason `rate-limited`, never emits quota.exhausted.
// A 1113 insufficient-balance tail stays a genuine quota exhaustion.
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	limitKindOf,
	quotaSweep,
} from "../hooks/lib/fleet-loop/quota-sweep.ts";

const TAIL_1302 =
	'API Error (429): {"error":{"code":"1302","message":"Rate limit reached for requests"}}\n';
const TAIL_1113 =
	'API Error (429): {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}\n';

const world = (sid, tail) => {
	const root = mkdtempSync(join(tmpdir(), "forkE-limit-"));
	mkdirSync(join(root, ".fleet"), { recursive: true });
	const log = join(root, ".fleet", `lane-${sid}.log`);
	writeFileSync(log, `working\n${tail}`);
	const stale = new Date(Date.now() - 16 * 60_000);
	utimesSync(log, stale, stale);
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items (id TEXT, project TEXT, state TEXT, owner_sid TEXT, updated_at INTEGER)",
	);
	db.run(
		"INSERT INTO work_items VALUES ('W1', ?, 'CLAIMED', ?, 1710000001)",
		`${root}/.git`,
		sid,
	);
	return { root, db };
};

const sweep = async (sid, tail) => {
	const { root, db } = world(sid, tail);
	const emitted = [];
	const reclaims = [];
	try {
		const report = await quotaSweep({
			db,
			buckleDb: null,
			probeLive: () => false,
			act: true,
			recentEmit: () => false,
			emit: (_s, note) => {
				emitted.push(note);
			},
			broadcast: () => 1,
			reclaim: (claim) => {
				reclaims.push(claim.reason);
				return {
					code: 0,
					out: JSON.stringify({
						project: claim.project,
						id: claim.id,
						previousOwner: claim.owner,
						previousUpdatedAt: claim.revision,
						released: true,
					}),
				};
			},
		});
		return { verdict: report.verdicts[0], emitted, reclaims };
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
};

test.describe("quota-sweep limit classes (fork E) @unit", () => {
	test("1302 classifies rate-limited, 1113 classifies quota", () => {
		expect(limitKindOf(TAIL_1302)).toBe("rate-limited");
		expect(limitKindOf(TAIL_1113)).toBe("quota");
		expect(limitKindOf('{"code":"1305","error":"busy"}')).toBe("rate-limited");
	});

	test("dead lane with a 1302 tail → rate-limited reclaim, no quota.exhausted", async () => {
		const r = await sweep("autow1302", TAIL_1302);
		expect(r.verdict?.exhausted).toBe(false);
		expect(r.verdict?.rateLimited).toBe(true);
		expect(r.reclaims).toEqual(["rate-limited"]);
		expect(r.emitted).toEqual([]);
	});

	test("dead lane with a 1113 tail → quota-exhausted, crash reclaim + emit", async () => {
		const r = await sweep("autow1113", TAIL_1113);
		expect(r.verdict?.exhausted).toBe(true);
		expect(r.verdict?.rateLimited).toBe(false);
		expect(r.reclaims).toEqual(["crash"]);
		expect(r.emitted.length).toBe(1);
	});
});
