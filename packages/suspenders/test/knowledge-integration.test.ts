// knowledge-integration.test.ts — W1213.4: the ASSEMBLED whole. The original
// W1213 feature plus the four reviewed corrections (W1213.1 scope-boundary
// auth, W1213.2 cursor-on-rejection, W1213.3 monotonic tombstone replay,
// W1213.3.1/.1.1 causal high-water on both dedupe paths) verified TOGETHER
// through the production face — the real knowledge-api bin, real SQLite, two
// minted per-machine TTL roll keys, and the real sync client. The per-fix
// suites prove each correction in isolation; this proves the corrections
// compose: auth while replaying, scope while replaying, cursor while the hub
// reorders, on one server over one db.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ROLL_KEY_HEADER } from "../hooks/lib/knowledge/knowledge-roll.ts";
import {
	postRoll,
	readSyncState,
	syncOnce,
	type SyncTarget,
} from "../hooks/lib/knowledge/knowledge-sync.ts";
import { unusedPort } from "./helpers/board-fixture.ts";

const HOME = mkdtempSync(join(tmpdir(), "w12134-int-home-"));
const GOVDB_TS = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const KEYS_FILE = join(HOME, "roll-keys.json");
const PORT = unusedPort();
const BASE = `http://127.0.0.1:${PORT}`;

// seed through the REAL migration path (HOME-isolated): openGovernorDb mints
// the install write token + creates knowledge.db; rolls land in that SQLite.
const seedScript = [
	"const { openGovernorDb, openKnowledgeDb } = await import(process.env.W_GOVDB);",
	"openGovernorDb();",
	"openKnowledgeDb();",
	"console.log('seeded');",
].join("\n");
const seed = Bun.spawnSync(["bun", "-e", seedScript], {
	env: { ...process.env, HOME, W_GOVDB: GOVDB_TS },
	stdout: "pipe",
	stderr: "pipe",
});
if (!seed.stdout.toString().includes("seeded"))
	console.error("seed failed:", seed.stderr.toString(), seed.stdout.toString());

// two per-machine TTL keys, minted ON this dev hub exactly as a spoke would:
// the mint verb appends to SUSPENDERS_ROLL_KEYS_FILE, the server reads the
// same file — provenance resolves FROM the key on every roll.
const MINT_ENV = {
	...process.env,
	HOME,
	SUSPENDERS_ROLL_KEYS_FILE: KEYS_FILE,
};
for (const machine of ["machine-a", "machine-b"]) {
	const minted = Bun.spawnSync(["bun", API_TS, "--mint-roll-key", machine], {
		env: MINT_ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	const key = (JSON.parse(minted.stdout.toString()) as { key: string }).key;
	writeFileSync(join(HOME, `roll-key-${machine}.secret`), key, { mode: 0o600 });
}

const proc = Bun.spawn(["bun", API_TS], {
	env: {
		...process.env,
		HOME,
		KNOWLEDGE_API_PORT: String(PORT),
		SUSPENDERS_ROLL_KEYS_FILE: KEYS_FILE,
	},
	stdout: "pipe",
	stderr: "pipe",
});

afterAll(() => {
	proc.kill();
	rmSync(HOME, { recursive: true, force: true });
});

const token = (): string =>
	readFileSync(
		join(HOME, ".cache", "claude-governor", "write-token"),
		"utf8",
	).trim();
const keyOf = (machine: string): string =>
	readFileSync(join(HOME, `roll-key-${machine}.secret`), "utf8").trim();

const roll = async (
	claims: unknown[],
	machine: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> => {
	const res = await fetch(`${BASE}/roll`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(machine ? { [ROLL_KEY_HEADER]: keyOf(machine) } : {}),
		},
		body: JSON.stringify({ claims }),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
};

interface HttpClaim {
	evidenceId: string;
	tombstone: boolean;
	scope: string;
	provenanceCount: number;
	provenance: { machine: string; ts: number; retract?: boolean }[];
}

/** the bounded keyed read (what a spoke sees) and the operator full read. */
const keyedView = async (machine: string): Promise<{ claims: HttpClaim[] }> =>
	(await (
		await fetch(`${BASE}/roll`, {
			headers: { [ROLL_KEY_HEADER]: keyOf(machine) },
		})
	).json()) as { claims: HttpClaim[] };
const fullView = async (): Promise<{ claims: HttpClaim[] }> =>
	(await (
		await fetch(`${BASE}/roll`, { headers: { "x-klh-write-token": token() } })
	).json()) as { claims: HttpClaim[] };

const up = async (): Promise<boolean> =>
	fetch(`${BASE}/health`)
		.then((r) => r.ok)
		.catch(() => false);

test("roll api boots on loopback", async () => {
	for (let i = 0; i < 60 && !(await up()); i++) await Bun.sleep(150);
	expect(await up()).toBe(true);
});

// ─── W1213.1: the assembled auth + scope boundary ───────────────────────────

const FLEET_A = {
	evidenceId: "ev-int-fleet",
	claim: "integration fleet-plane claim",
	confidence: 0.8,
	ts: 110,
	scope: "fleet",
};

test("the assembled auth + scope boundary (W1213.1 B1) on the wire", async () => {
	// anonymous writes and reads get NOTHING (the B1 finding: the aggregate
	// discloses tenant intel) — fail closed on every face
	expect((await roll([FLEET_A], null)).status).toBe(403);
	const bogus = await fetch(`${BASE}/roll`, {
		method: "POST",
		headers: { [ROLL_KEY_HEADER]: "klh-rk-bogus" },
		body: JSON.stringify({ claims: [FLEET_A] }),
	});
	expect(bogus.status).toBe(403);
	expect((await fetch(`${BASE}/roll`)).status).toBe(403);
	expect((await roll([FLEET_A], "machine-a")).body.counts?.versions).toBe(1);
});
test("machine-scope reads bound to the asserting tenant (W1213.1)", async () => {
	expect(
		(
			await roll(
				[
					{
						evidenceId: "ev-int-priv",
						claim: "machine-a private claim",
						confidence: 0.7,
						ts: 100,
						scope: "machine",
					},
				],
				"machine-a",
			)
		).body.counts?.versions,
	).toBe(1);
	// the bounded read: machine-a sees its private row, machine-b never does
	const aView = await keyedView("machine-a");
	expect(aView.claims.find((c) => c.evidenceId === "ev-int-priv")).toBeTruthy();
	const bView = await keyedView("machine-b");
	expect(bView.claims.find((c) => c.evidenceId === "ev-int-priv")).toBe(
		undefined,
	);
	expect(
		bView.claims.find((c) => c.evidenceId === "ev-int-fleet"),
	).toBeTruthy();
});
test("unknown and missing scope fail closed on the wire (W1213.1)", async () => {
	for (const bad of [
		{ ...FLEET_A, evidenceId: "ev-int-bad1", scope: "unknown-private-scope" },
		{
			evidenceId: "ev-int-bad2",
			claim: "no scope at all",
			confidence: 0.5,
			ts: 120,
		},
	]) {
		const r = await roll([bad], "machine-a");
		expect(r.status).toBe(422);
		expect(r.body.error).toContain("invalid claim entry");
	}
	// the rejected entries landed nothing
	expect(
		(await fullView()).claims.filter((claim) =>
			claim.evidenceId.startsWith("ev-int-bad"),
		),
	).toHaveLength(0);
});
test("scope is an immutable key dimension on the wire (W1213.1.1)", async () => {
	// the same identity asserted under BOTH scopes lands two rows; neither
	// mutates the other — a foreign public re-assertion cannot widen a
	// private row, and a private row can never leak into the fleet plane
	const dualEntry = {
		evidenceId: "ev-int-dual",
		claim: "dual-plane identity",
		confidence: 0.8,
	};
	expect(
		(await roll([{ ...dualEntry, ts: 130, scope: "machine" }], "machine-a"))
			.body.counts?.versions,
	).toBe(1);
	expect(
		(await roll([{ ...dualEntry, ts: 131, scope: "fleet" }], "machine-b")).body
			.counts?.versions,
	).toBe(1);
	const dual = (await fullView()).claims.filter(
		(claim) => claim.evidenceId === "ev-int-dual",
	);
	expect(dual).toHaveLength(2);
	expect(dual.map((claim) => claim.scope).sort()).toEqual(["fleet", "machine"]);
	expect(dual.find((claim) => claim.scope === "machine")?.provenanceCount).toBe(
		1,
	);
});
// ─── W1213.2: the cursor contract on the wire ───────────────────────────────

// the sync-loop fixture, built in the first cursor test and consumed by the
// second (each test must stay a closed unit under the assembly gates)
let SYNC_DIR: string;
let SYNC_TARGET: SyncTarget;

test("the cursor contract on the wire (W1213.2 B2): 422 is never an ack", async () => {
	const target: SyncTarget = {
		url: BASE,
		writeTokenFile: join(HOME, "hub.token"),
		rollUrl: BASE,
		rollKeyFile: join(HOME, "roll-key-machine-a.secret"),
	};
	// the client seam: a rejected roll arrives as "HTTP 422" in the outcome —
	// never read as acceptance, so the cursor cannot stamp
	const bad = await postRoll(target, [
		{
			evidenceId: "ev-cursor-bad",
			claim: "invalid confidence",
			confidence: 2,
			ts: 1,
			scope: "fleet",
		},
	]);
	expect(bad.ok).toBe(false);
	expect(bad.error).toContain("422");
	expect(
		(await fullView()).claims.filter(
			(claim) => claim.evidenceId === "ev-cursor-bad",
		),
	).toHaveLength(0);
});
test("syncOnce stamps the claims cursor only on the accepted set", async () => {
	// the accepted path rides a positive ack: both facts rows stamp; the pass
	// repeats dupe-safe — the second pass re-sends nothing and the hub lands
	// NO second provenance row
	const target: SyncTarget = {
		url: BASE,
		writeTokenFile: join(HOME, "hub.token"),
		rollUrl: BASE,
		rollKeyFile: join(HOME, "roll-key-machine-a.secret"),
	};
	const good = await postRoll(target, [
		{
			evidenceId: "ev-cursor-ok",
			claim: "positive acks stamp the cursor",
			confidence: 0.6,
			ts: 2,
			scope: "fleet",
		},
	]);
	expect(good.ok).toBe(true);
	expect(good.error).toBeNull();
	SYNC_DIR = mkdtempSync(join(tmpdir(), "w12134-int-sync-"));
	SYNC_TARGET = target;
});
/** a claims facts db with two rows (plain-text + JSON-shaped). */
const claimsDb = (dir: string): string => {
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL, confidence REAL)",
	);
	db.run(
		"INSERT INTO facts VALUES ('claim.int-a', 'integration sync claim a', 'lane', 1, 11, 0.8)",
	);
	db.run(
		"INSERT INTO facts VALUES ('claim.int-b', '{\"claim\":\"integration sync claim b\",\"confidence\":0.9}', 'lane', 2, 12, 0.9)",
	);
	db.close();
	return dbPath;
};
test("the claims cursor stamps exactly and repeats dupe-safe", async () => {
	const dbPath = claimsDb(SYNC_DIR);
	const cfgPath = join(SYNC_DIR, "knowledge-sync.json");
	const policy = {
		facts: false,
		metrics: false,
		metricsSessions: false,
		claims: true,
	};
	writeFileSync(
		cfgPath,
		JSON.stringify({
			localHub: "w12134-devbox",
			targets: [SYNC_TARGET],
			policy,
			decantBin: "decant",
		}),
		{ mode: 0o600 },
	);
	const statePath = join(SYNC_DIR, "state.json");
	await syncOnce({ configPath: cfgPath, statePath, dbPath });
	const st = readSyncState(statePath);
	expect(Object.keys(st.claims).sort()).toEqual(["claim.int-a", "claim.int-b"]);
	// the repeat pass re-sends nothing new and lands NO second provenance row
	await syncOnce({ configPath: cfgPath, statePath, dbPath });
	const landed = (await fullView()).claims.find(
		(claim) => claim.evidenceId === "int-a",
	);
	expect(landed?.provenanceCount).toBe(1);
	rmSync(SYNC_DIR, { recursive: true, force: true });
});
// ─── W1213.3/.1/.1.1: the causal high-water converges on the wire ──────────

/** a fleet-plane roll entry body with room for the per-event ts/tombstone. */
const EV = (id: string, claim: string) => ({
	evidenceId: id,
	claim,
	confidence: 0.8,
	scope: "fleet",
});

test("B3 replays stale on the wire (W1213.3)", async () => {
	const ev = EV("ev-wire-b3", "contested wire claim");
	expect(
		(await roll([{ ...ev, ts: 100 }], "machine-a")).body.counts?.versions,
	).toBe(1);
	const tomb = { ...ev, ts: 200, tombstone: true };
	expect((await roll([tomb], "machine-b")).body.counts?.tombstoned).toBe(1);
	expect(
		(await roll([{ ...ev, ts: 300 }], "machine-a")).body.counts?.merged,
	).toBe(1);
	// the 200 tombstone replay: stale — no re-hide, no provenance churn
	const replay = await roll([tomb], "machine-b");
	expect(replay.body.counts?.stale).toBe(1);
	expect(replay.body.counts?.tombstoned).toBe(0);
	const view = (await fullView()).claims.find(
		(claim) => claim.evidenceId === "ev-wire-b3",
	);
	expect(view?.tombstone).toBe(false);
	// provenanceCount counts ASSERTIONS: two asserts + the one standing
	// retraction ride the provenance list
	expect(view?.provenanceCount).toBe(2);
	expect(view?.provenance).toHaveLength(3);
	expect(
		view?.provenance.some((p) => p.machine === "machine-b" && !!p.retract),
	).toBe(true);
});
test("FAIL61611 on the wire: the deduped assert carries time (W1213.3.1.1)", async () => {
	const ev = EV("ev-wire-f61", "dupe carries time");
	expect(
		(await roll([{ ...ev, ts: 100 }], "machine-a")).body.counts?.versions,
	).toBe(1);
	// identical payload, NEWER ts: deduped, but the standing mark must move
	expect(
		(await roll([{ ...ev, ts: 500 }], "machine-a")).body.counts?.dupes,
	).toBe(1);
	// a stale tomb 400 behind the dupe cannot hide the claim
	expect(
		(await roll([{ ...ev, ts: 400, tombstone: true }], "machine-b")).body.counts
			?.stale,
	).toBe(1);
	const view = (await fullView()).claims.find(
		(claim) => claim.evidenceId === "ev-wire-f61",
	);
	expect(view?.tombstone).toBe(false);
	expect(view?.provenanceCount).toBe(1);
});
test("equal clocks and exact same-ts re-push on the wire", async () => {
	const ev = EV("ev-wire-tie", "tie clock claim");
	expect(
		(await roll([{ ...ev, ts: 500 }], "machine-a")).body.counts?.versions,
	).toBe(1);
	// equal clocks: the retractor wins the tie — the row hides (tombstoned
	// rows leave the view), and the LATER assert proves it by reviving
	const tied = await roll([{ ...ev, ts: 500, tombstone: true }], "machine-b");
	expect(tied.body.counts?.tombstoned).toBe(1);
	expect(
		(await fullView()).claims.find(
			(claim) => claim.evidenceId === "ev-wire-tie",
		),
	).toBeUndefined();
	// a later assert revives; then the exact same-ts re-push is a zero-churn dupe
	expect(
		(await roll([{ ...ev, ts: 700 }], "machine-a")).body.counts?.merged,
	).toBe(1);
	expect(
		(await roll([{ ...ev, ts: 500 }], "machine-a")).body.counts?.dupes,
	).toBe(1);
	const view = (await fullView()).claims.find(
		(claim) => claim.evidenceId === "ev-wire-tie",
	);
	expect(view?.tombstone).toBe(false);
	expect(view?.provenanceCount).toBe(2);
});
