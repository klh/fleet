// test/reconcile-abandoned.test.ts — W1124.31: the proof-gated
// abandoned-receipt reconcile. Ledger-level: every fail-closed refusal
// code, the verdict shape with pinned proofs, immutability, reason cap and
// read exposure. Gate-level: the POST route's auth classes, bad-body 400,
// fail-closed 409 on a fresh row, one audited success (verdict + read
// exposure + the chained auth event on a file db), chain verify.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Ledger, type RouteAuditDecision } from "../src/ledger.ts";
import {
	parseAbandonedReceipt,
	RECONCILE_REASON_CAP,
} from "../src/reconcile.ts";
import { startServer } from "../src/server.ts";

const OLD_TS = "2020-06-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const BOOT = NOW - 10_000_000;
const TRACE = "a".repeat(32);

let seq = 0;

function decision(over: Partial<RouteAuditDecision> = {}): RouteAuditDecision {
	seq += 1;
	return {
		rid: `rid${String(seq).padStart(4, "0")}`,
		ts: OLD_TS,
		actor: "k1",
		lane: "lane-x",
		dialect: "anthropic",
		hint: "",
		candidates_seen: 1,
		candidates_top: "test-model",
		target_kind: "local",
		target_host: "127.0.0.1",
		target_port: 8902,
		target_model: "test-model",
		decision: "select",
		latency_class: "fast",
		tier: "local",
		allow_cloud: false,
		error_code: null,
		why: "",
		hop: "origin",
		...over,
	};
}

function ledger(): Ledger {
	return new Ledger(":memory:", undefined, { maxStreamMs: 900_000 });
}

test("abandoned verdict lands and rides the admin read", () => {
	const l = ledger();
	l.auditDecision(decision());
	const r = l.reconcileAbandoned(
		{ rid: "rid0001", lane: "lane-x", actor: "admin-k", reason: "drain" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(r.ok).toBe(true);
	if (!r.ok) return;
	expect(r.verdict.verdict).toBe("abandoned");
	expect(r.verdict.at).toBe(new Date(NOW).toISOString());
	expect(r.verdict.age_ms).toBe(NOW - Date.parse(OLD_TS));
	expect(r.verdict.boot_origin).toBe(BOOT);
	const row = l.requestsRead({ lane: "lane-x", limit: 50 })[0];
	expect(row?.reconciled?.verdict).toBe("abandoned");
	expect(row?.status).toBeNull();
	expect(row?.ok).toBeNull();
});

test("verdicts are immutable — second reconcile refuses", () => {
	const l = ledger();
	const d = decision();
	l.auditDecision(d);
	l.reconcileAbandoned(
		{ rid: d.rid, lane: "lane-x", actor: "a", reason: "drain" },
		{ now: NOW, bootOrigin: BOOT },
	);
	const again = l.reconcileAbandoned(
		{ rid: d.rid, lane: "lane-x", actor: "a", reason: "drain" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(again.ok).toBe(false);
	if (again.ok) return;
	expect(again.code).toBe("buckle.receipt_reconciled");
});

test("every fail-closed refusal code fires on its proof failure", () => {
	const l = ledger();
	// no such receipt
	const none = l.reconcileAbandoned(
		{ rid: "missing", lane: "lane-x", actor: "a", reason: "d" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(none.ok).toBe(false);
	if (!none.ok) expect(none.code).toBe("buckle.no_such_receipt");
	// lane mismatch (exact-lane guard)
	const d1 = decision();
	l.auditDecision(d1);
	const wrongLane = l.reconcileAbandoned(
		{ rid: d1.rid, lane: "other", actor: "a", reason: "d" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(wrongLane.ok).toBe(false);
	if (!wrongLane.ok)
		expect(wrongLane.code).toBe("buckle.receipt_lane_mismatch");
	// trace/ts exact-match refusals
	const d2 = decision({ trace_id: TRACE });
	l.auditDecision(d2);
	const wrongTrace = l.reconcileAbandoned(
		{
			rid: d2.rid,
			lane: "lane-x",
			trace_id: "b".repeat(32),
			actor: "a",
			reason: "d",
		},
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(wrongTrace.ok).toBe(false);
	if (!wrongTrace.ok) expect(wrongTrace.code).toBe("buckle.receipt_mismatch");
});

test("settled, non-inference and live rows refuse", () => {
	const l = ledger();
	// settled row (outcome landed)
	const d1 = decision();
	l.auditDecision(d1);
	l.auditOutcome(d1.rid, { status: 200, duration_ms: 5, ok: true, err: null });
	const settled = l.reconcileAbandoned(
		{ rid: d1.rid, lane: "lane-x", actor: "a", reason: "d" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(settled.ok).toBe(false);
	if (!settled.ok) expect(settled.code).toBe("buckle.receipt_settled");
	// non-inference row (no target model)
	const d2 = decision({ target_model: null });
	l.auditDecision(d2);
	const bare = l.reconcileAbandoned(
		{ rid: d2.rid, lane: "lane-x", actor: "a", reason: "d" },
		{ now: NOW, bootOrigin: BOOT },
	);
	expect(bare.ok).toBe(false);
	if (!bare.ok) expect(bare.code).toBe("buckle.receipt_not_inference");
	// live incarnation: row postdates this gate's boot
	const liveTs = new Date(Date.now() - 1000).toISOString();
	const d3 = decision({ ts: liveTs });
	l.auditDecision(d3);
	const live = l.reconcileAbandoned(
		{ rid: d3.rid, lane: "lane-x", actor: "a", reason: "d" },
		{ now: Date.now(), bootOrigin: Date.parse(liveTs) - 500 },
	);
	expect(live.ok).toBe(false);
	if (!live.ok) expect(live.code).toBe("buckle.receipt_live_incarnation");
});

test("transport-bound rows refuse and the parser is fail-closed", () => {
	const l = ledger();
	const d = decision();
	l.auditDecision(d);
	// age within the live-stream guard (900s): now barely past the row's ts
	const bound = l.reconcileAbandoned(
		{ rid: d.rid, lane: "lane-x", actor: "a", reason: "d" },
		{ now: Date.parse(OLD_TS) + 100, bootOrigin: BOOT },
	);
	expect(bound.ok).toBe(false);
	if (!bound.ok) expect(bound.code).toBe("buckle.receipt_transport_bound");
	const r = l.reconcileAbandoned(
		{ rid: d.rid, lane: "lane-x", actor: "a", reason: "x".repeat(400) },
		{ now: NOW, bootOrigin: BOOT },
	);
	if (!r.ok) return;
	expect(r.verdict.reason.length).toBe(RECONCILE_REASON_CAP);
	expect(parseAbandonedReceipt("not json")).toBeNull();
	expect(parseAbandonedReceipt('{"verdict":"other"}')).toBeNull();
	expect(parseAbandonedReceipt(null)).toBeNull();
});

const ROOT = "buckle-reconcile-root";

interface Gate {
	base: string;
	dbPath: string;
	gov: ReturnType<typeof startServer>["gov"];
	stop(): void;
}

async function startGate(): Promise<Gate> {
	const dir = `/tmp/buckle-rec-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	const cfg = `groups:\n  glm-5.3-flash:\n    - url: http://127.0.0.1:1\n      dialect: openai\n`;
	await Bun.write(`${dir}.yaml`, cfg);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: dir,
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		dbPath: dir,
		gov: server.gov,
		stop: () => server.stop(true),
	};
}

async function reconcile(
	base: string,
	token: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${base}/v1/admin/requests/reconcile`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
}

function insertGateRow(
	gov: ReturnType<typeof startServer>["gov"],
	rid: string,
	ts: string,
): void {
	gov.ledger.auditDecision(
		decision({ rid, lane: "gate-lane", trace_id: TRACE, ts }),
	);
}

test("reconcile route: 401 bare, 403 proxy-scoped, 400 bad body", async () => {
	const g = await startGate();
	try {
		const bare = await reconcile(g.base, "", { rid: "x", lane: "y" });
		expect(bare.status).toBe(401);
		const issued = await fetch(`${g.base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "lane", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const laneKey = (await issued.json()) as { key: string };
		const proxy = await reconcile(g.base, laneKey.key ?? "", {
			rid: "x",
			lane: "y",
		});
		expect(proxy.status).toBe(403);
		const bad = await reconcile(g.base, ROOT, { lane: "gate-lane" });
		expect(bad.status).toBe(400);
	} finally {
		g.stop();
	}
});

test("reconcile route: 409 fail-closed on a fresh live-incarnation row", async () => {
	const g = await startGate();
	try {
		const freshTs = new Date().toISOString();
		insertGateRow(g.gov, "ridfresh", freshTs);
		const res = await reconcile(g.base, ROOT, {
			rid: "ridfresh",
			lane: "gate-lane",
			reason: "drain",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("buckle.receipt_live_incarnation");
	} finally {
		g.stop();
	}
});

test("reconcile route: audited success with chained auth event", async () => {
	const g = await startGate();
	try {
		insertGateRow(g.gov, "ridold", OLD_TS);
		const res = await reconcile(g.base, ROOT, {
			rid: "ridold",
			lane: "gate-lane",
			trace_id: TRACE,
			ts: OLD_TS,
			reason: "restart-scoped-drain",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { reconciled?: string };
		expect(body.reconciled).toBe("ridold");
		// verdict rides the admin read
		const read = await fetch(
			`${g.base}/v1/admin/requests?lane=gate-lane&inference=true`,
			{ headers: { authorization: `Bearer ${ROOT}` } },
		);
		const rows = (await read.json()) as {
			requests?: Array<{
				rid: string;
				reconciled: { verdict: string } | null;
			}>;
		};
		expect(rows.requests?.[0]?.reconciled?.verdict).toBe("abandoned");
	} finally {
		g.stop();
	}
});

test("reconcile route: chained auth event lands and the chain verifies", async () => {
	const g = await startGate();
	try {
		insertGateRow(g.gov, "ridchain", OLD_TS);
		const res = await reconcile(g.base, ROOT, {
			rid: "ridchain",
			lane: "gate-lane",
			reason: "restart-scoped-drain",
		});
		expect(res.status).toBe(200);
		const db = new Database(g.dbPath, { readonly: true });
		const hit = db
			.query(
				"SELECT actor, via FROM auth_events WHERE event = 'reconciled' AND jti = 'ridchain'",
			)
			.get() as { actor: string; via: string } | null;
		db.close();
		expect(hit?.via).toBe("admin");
		const chain = await fetch(`${g.base}/v1/admin/audit/verify`, {
			headers: { authorization: `Bearer ${ROOT}` },
		});
		const verdict = (await chain.json()) as { ok?: boolean };
		expect(verdict.ok).toBe(true);
	} finally {
		g.stop();
	}
});
