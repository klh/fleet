// test/knowledge-roll.test.ts — W1213: the upward claim roll. Covers the
// content-addressed identity (claimHash), the facts-row parser, the four
// acceptance criteria (same evidence+claim from two machines → ONE fact with
// provenance 2; differing claims → two VERSIONS; tombstones stop appearing
// without deletion; re-push = zero dupes), the scoped TTL keys, and the
// machine-side collection pass. Aggregate cores are db-injected — in-memory
// Database, no board/db fixtures.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAIM_FACT,
	aggregateClaims,
	claimAggregateView,
	claimHash,
	collectClaims,
	parseClaimRow,
	mintRollKey,
	rollKeyOk,
} from "../hooks/lib/knowledge-roll.ts";
import { readSyncConfig } from "../hooks/lib/knowledge-sync-policy.ts";

// ─── claim identity ────────────────────────────────────────────────────────

test("claimHash: same evidence+claim hashes identically from any pusher", () => {
	expect(claimHash("ev-1", "the build is green")).toBe(
		claimHash("ev-1", "the build is green"),
	);
});

test("claimHash: differing evidence or claim → different hash", () => {
	expect(claimHash("ev-1", "c")).not.toBe(claimHash("ev-2", "c"));
	expect(claimHash("ev-1", "c")).not.toBe(claimHash("ev-1", "c2"));
});

// ─── the facts-row parser ───────────────────────────────────────────────────

test("parseClaimRow: JSON shape carries claim/confidence/tombstone", () => {
	const e = parseClaimRow(
		"claim.ldap-4651",
		JSON.stringify({ claim: "auth flows through ldap", confidence: 0.9 }),
	);
	expect(e).not.toBeNull();
	expect(e?.evidenceId).toBe("ldap-4651");
	expect(e?.claim).toBe("auth flows through ldap");
	expect(e?.confidence).toBe(0.9);
	expect(e?.tombstone).toBe(false);
});

test("parseClaimRow: plain-text values degrade to claim text; tombstone flag survives", () => {
	const e = parseClaimRow("claim.x1", "plain assertion text");
	expect(e?.claim).toBe("plain assertion text");
	const t = parseClaimRow(
		"claim.x1",
		JSON.stringify({ claim: "same text", tombstone: true }),
	);
	expect(t?.claim).toBe("same text");
	expect(t?.tombstone).toBe(true);
});

test("parseClaimRow: non-claim keys, empties, oversize text refuse", () => {
	expect(CLAIM_FACT.test("lesson.thing")).toBe(false);
	expect(parseClaimRow("claim.", "x")).toBeNull();
	expect(parseClaimRow("claim.ok", "   ")).toBeNull();
	expect(parseClaimRow("claim.ok", "x".repeat(2001))).toBeNull();
	expect(parseClaimRow("claim.ok", JSON.stringify({ claim: "  " }))).toBeNull();
});

test("parseClaimRow: declared scope parses; unknown scope refuses the row", () => {
	const ok = parseClaimRow(
		"claim.s1",
		JSON.stringify({ claim: "scoped", scope: "machine" }),
	);
	expect(ok?.scope).toBe("machine");
	const def = parseClaimRow("claim.s2", JSON.stringify({ claim: "plain" }));
	expect(def?.scope).toBe("fleet");
	expect(
		parseClaimRow(
			"claim.s3",
			JSON.stringify({ claim: "x", scope: "unknown-private-scope" }),
		),
	).toBeNull();
});

// ─── the aggregate: the four acceptance criteria ───────────────────────────

test("aggregate: two machines, same evidence+claim → ONE fact, provenance 2", () => {
	const db = new Database(":memory:");
	const claim = {
		evidenceId: "ev-1",
		claim: "auth is ldap-backed",
		confidence: 0.8,
		ts: 100,
		scope: "fleet",
	};
	const r1 = aggregateClaims(db, [claim], "machine-a", { now: 1000 });
	expect(r1.ok).toBe(true);
	const r2 = aggregateClaims(db, [claim], "machine-b", { now: 2000 });
	expect(r2.ok).toBe(true);
	expect(r2.counts).toEqual({
		merged: 1,
		versions: 0,
		tombstoned: 0,
		stale: 0,
		dupes: 0,
	});
	const view = claimAggregateView(db);
	expect(view.claims).toHaveLength(1);
	expect(view.claims[0].provenanceCount).toBe(2);
	expect(view.claims[0].version).toBe(1);
});

test("aggregate: differing claims to the same evidence → two VERSIONS", () => {
	const db = new Database(":memory:");
	const r1 = aggregateClaims(
		db,
		[
			{
				evidenceId: "ev-9",
				claim: "v1 text",
				confidence: 0.6,
				ts: 100,
				scope: "fleet",
			},
		],
		"machine-a",
	);
	const r2 = aggregateClaims(
		db,
		[
			{
				evidenceId: "ev-9",
				claim: "v2 text",
				confidence: 0.9,
				ts: 200,
				scope: "fleet",
			},
		],
		"machine-a",
	);
	expect(r1.ok && r2.ok).toBe(true);
	expect(r2.counts?.versions).toBe(1);
	const view = claimAggregateView(db);
	expect(view.claims).toHaveLength(2);
	expect(view.claims.map((c) => c.version).sort()).toEqual([1, 2]);
});

test("aggregate: tombstone hides the claim without deleting the row", () => {
	const db = new Database(":memory:");
	const body = {
		evidenceId: "ev-2",
		claim: "stale claim",
		confidence: 0.7,
		ts: 100,
		scope: "fleet",
	};
	aggregateClaims(db, [body], "machine-a", { now: 1000 });
	// a SECOND machine retracts — the tombstone propagates to the aggregate
	const ret = aggregateClaims(db, [{ ...body, tombstone: true }], "machine-b", {
		now: 2000,
	});
	expect(ret.counts?.tombstoned).toBe(1);
	expect(claimAggregateView(db).claims).toHaveLength(0);
	const withT = claimAggregateView(db, { includeTombstones: true });
	expect(withT.claims).toHaveLength(1);
	expect(withT.claims[0].tombstone).toBe(true);
});

test("aggregate: re-push from the same machine = idempotent dupe", () => {
	const db = new Database(":memory:");
	const body = {
		evidenceId: "ev-3",
		claim: "same content",
		confidence: 0.5,
		ts: 100,
		scope: "fleet",
	};
	aggregateClaims(db, [body], "machine-a", { now: 1000 });
	const again = aggregateClaims(db, [body], "machine-a", { now: 2000 });
	expect(again.counts?.dupes).toBe(1);
	expect(again.counts?.merged).toBe(0);
	expect(claimAggregateView(db).claims[0].provenanceCount).toBe(1);
});

test("aggregate: newer assertion revives; stale assertion does not", () => {
	const db = new Database(":memory:");
	const body = {
		evidenceId: "ev-4",
		claim: "contested claim",
		confidence: 0.8,
		ts: 500,
		scope: "fleet",
	};
	aggregateClaims(db, [body], "machine-a", { now: 1000 });
	aggregateClaims(db, [{ ...body, tombstone: true }], "machine-b", {
		now: 2000,
	});
	// ts BEFORE the tombstone → stale (ignored, row stays dead); ts AFTER → revive
	const stale = aggregateClaims(db, [{ ...body, ts: 200 }], "machine-a", {
		now: 3000,
	});
	expect(stale.counts?.stale).toBe(1);
	expect(claimAggregateView(db).claims).toHaveLength(0);
	const live = aggregateClaims(db, [{ ...body, ts: 3000 }], "machine-a", {
		now: 4000,
	});
	expect(live.counts?.merged).toBe(1);
	expect(claimAggregateView(db).claims).toHaveLength(1);
});

// ─── W1213.1 — the scope boundary (fail closed) ─────────────────────────────

test("aggregate: unknown scope fails closed — roll rejected, nothing stored", () => {
	const db = new Database(":memory:");
	const r = aggregateClaims(
		db,
		[
			{
				evidenceId: "ev-b1",
				claim: "probe claim",
				confidence: 0.5,
				ts: 100,
				scope: "unknown-private-scope",
			},
		],
		"machine-a",
	);
	expect(r.ok).toBe(false);
	expect(r.error).toBe("invalid claim entry");
	expect(claimAggregateView(db).claims).toHaveLength(0);
});

test("aggregate: missing scope fails closed", () => {
	const db = new Database(":memory:");
	const r = aggregateClaims(
		db,
		[{ evidenceId: "ev-b2", claim: "probe", confidence: 0.5, ts: 100 }],
		"machine-a",
	);
	expect(r.ok).toBe(false);
	expect(claimAggregateView(db).claims).toHaveLength(0);
});

test("aggregate: unknown entry field fails closed (strict wire schema)", () => {
	const db = new Database(":memory:");
	const entry = {
		evidenceId: "ev-b3",
		claim: "probe",
		confidence: 0.5,
		ts: 100,
		scope: "fleet",
		tenant: "machine-z",
	};
	const r = aggregateClaims(db, [entry], "machine-a");
	expect(r.ok).toBe(false);
	expect(claimAggregateView(db).claims).toHaveLength(0);
});

test("readerMachine bounds the view: own machine + fleet, never foreign machine scopes", () => {
	const db = new Database(":memory:");
	const fleetClaim = {
		evidenceId: "ev-f1",
		claim: "shared assertion",
		confidence: 0.6,
		ts: 100,
		scope: "fleet",
	};
	aggregateClaims(db, [fleetClaim], "machine-a", { now: 1000 });
	aggregateClaims(db, [fleetClaim], "machine-b", { now: 2000 });
	aggregateClaims(
		db,
		[
			{
				evidenceId: "ev-p1",
				claim: "private to machine-a",
				confidence: 0.7,
				ts: 150,
				scope: "machine",
			},
		],
		"machine-a",
		{ now: 3000 },
	);
	const bView = claimAggregateView(db, { readerMachine: "machine-b" });
	expect(bView.claims.map((c) => c.evidenceId)).toEqual(["ev-f1"]);
	const aView = claimAggregateView(db, { readerMachine: "machine-a" });
	expect(aView.claims.map((c) => c.evidenceId).sort()).toEqual([
		"ev-f1",
		"ev-p1",
	]);
	const opView = claimAggregateView(db);
	expect(opView.claims.map((c) => c.evidenceId).sort()).toEqual([
		"ev-f1",
		"ev-p1",
	]);
	// the tenant roll-up derives from the visible set only — machine-b's view
	// knows machine-a only through the fleet claim's provenance, and the
	// private row's tenant data never leaks into it
	expect(bView.tenants.map((t) => t.machine).sort()).toEqual([
		"machine-a",
		"machine-b",
	]);
});

test("scope escalates fleet→machine on conflicting re-assertion, never loosens", () => {
	const db = new Database(":memory:");
	const body = {
		evidenceId: "ev-s1",
		claim: "same content",
		confidence: 0.5,
		ts: 100,
	};
	aggregateClaims(db, [{ ...body, scope: "fleet" }], "machine-a", {
		now: 1000,
	});
	aggregateClaims(db, [{ ...body, scope: "machine" }], "machine-b", {
		now: 2000,
	});
	const view = claimAggregateView(db);
	expect(view.claims[0].scope).toBe("machine");
	aggregateClaims(db, [{ ...body, scope: "fleet" }], "machine-c", {
		now: 3000,
	});
	expect(claimAggregateView(db).claims[0].scope).toBe("machine");
});

test("collectClaims: claim.* rows → entries; cursor skips; cap applies", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-cl-"));
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL, confidence REAL)",
	);
	db.run(
		"INSERT INTO facts VALUES ('claim.ev-1', ?, 'sync', 3, 500, 0.9), ('claim.ev-2', ?, 'sync', 1, 600, NULL), ('lesson.x', 'nope', 'sync', 1, 1, NULL)",
		JSON.stringify({ claim: "assertion one", confidence: 0.4 }),
		"claim two text",
	);
	const state: { claims?: Record<string, number> } = {
		claims: { "claim.ev-2": 1 },
	};
	const out = collectClaims(state, { dbPath });
	expect(out.send).toHaveLength(1);
	expect(out.send[0].evidenceId).toBe("ev-1");
	expect(out.send[0].confidence).toBe(0.4);
	expect(out.send[0].ts).toBe(500);
	expect(out.send[0].scope).toBe("fleet");
	expect(out.cursor).toEqual({ "claim.ev-1": 3 });
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

test("collectClaims: secret-bearing claim text is skipped, cursor not advanced", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-sec-"));
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL, confidence REAL)",
	);
	db.run(
		"INSERT INTO facts VALUES ('claim.sk1', '{\"claim\":\"creds ghp_TrapFixtureNotARealToken123\"}', 'sync', 1, 1, NULL)", // scrub:allow (trap fixture)
	);
	const out = collectClaims({}, { dbPath });
	expect(out.send).toHaveLength(0);
	expect(out.cursor["claim.sk1"]).toBeUndefined();
	expect(out.skipped[0]).toContain("secret pattern");
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

// ─── scoped TTL keys (the credential-free transport) ────────────────────────

test("roll keys: mint binds machine; wrong key refused; expiry enforced", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-key-"));
	const path = join(dir, "roll-keys.json");
	const now = 1_700_000_000_000;
	const { key, expiresAt } = mintRollKey("nas", 24, { path, now });
	expect(key.startsWith("klhroll_")).toBe(true);
	expect(expiresAt).toBe(now + 24 * 3_600_000);
	expect(rollKeyOk(key, { path, now })).toEqual({ ok: true, machine: "nas" });
	expect(rollKeyOk("klhroll_wrong", { path, now }).ok).toBe(false);
	expect(rollKeyOk("", { path, now }).ok).toBe(false);
	// after expiry the same key no longer validates
	expect(rollKeyOk(key, { path, now: now + 25 * 3_600_000 }).ok).toBe(false);
	rmSync(dir, { recursive: true, force: true });
});

test("roll keys: only the sha256 of the key is stored, never the key", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-keyf-"));
	const path = join(dir, "roll-keys.json");
	const { key } = mintRollKey("desktop", 1, { path, now: 1000 });
	const onDisk = readFileSync(path, "utf8");
	expect(onDisk).not.toContain(key);
	expect(onDisk).toContain("desktop");
	rmSync(dir, { recursive: true, force: true });
});

// ─── the sync-policy coupling (rollUrl/rollKeyFile together-rule) ──────────

test("policy: rollUrl without rollKeyFile (or vice versa) refuses", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-pol-"));
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [
				{
					url: "https://hub.local",
					writeTokenFile: "/tmp/t",
					rollUrl: "https://hub.local",
				},
			],
		}),
		{ mode: 0o600 },
	);
	expect(() => readSyncConfig(path)).toThrow(/rollUrl and rollKeyFile/);
	rmSync(dir, { recursive: true, force: true });
});

test("policy: rollUrl + rollKeyFile together parse; rollUrl origin-normalized", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1213-pol2-"));
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [
				{
					url: "https://hub.local",
					writeTokenFile: "/tmp/t",
					rollUrl: "https://hub.local:443/",
					rollKeyFile: "/home/me/.config/klh/roll-key",
				},
			],
		}),
		{ mode: 0o600 },
	);
	const cfg = readSyncConfig(path);
	expect(cfg?.targets[0]?.rollUrl).toBe("https://hub.local");
	expect(cfg?.targets[0]?.rollKeyFile).toBe("/home/me/.config/klh/roll-key");
	rmSync(dir, { recursive: true, force: true });
});
