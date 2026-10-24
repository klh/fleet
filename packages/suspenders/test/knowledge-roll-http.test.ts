// knowledge-roll-http.test.ts — W1213.3.1.1: the causal assert/retract
// high-water contract through the PRODUCTION face — the real knowledge-api
// bin on a real port over real SQLite. FAIL61611's convergence must hold on
// the wire, not only on the db-injected core.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unusedPort } from "./helpers/board-fixture.ts";

const HOME = mkdtempSync(join(tmpdir(), "w1213-roll-home-"));
const GOVDB_TS = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
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

const proc = Bun.spawn(["bun", API_TS], {
	env: { ...process.env, HOME, KNOWLEDGE_API_PORT: String(PORT) },
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

const roll = async (
	claims: unknown[],
	machine: string,
): Promise<{ ok: boolean; counts?: Record<string, number> }> => {
	const res = await fetch(`${BASE}/roll`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-klh-write-token": token(),
		},
		body: JSON.stringify({ claims, machine }),
	});
	return (await res.json()) as {
		ok: boolean;
		counts?: Record<string, number>;
	};
};

interface HttpClaim {
	evidenceId: string;
	tombstone: boolean;
	provenanceCount: number;
}

const claimView = async (ev: string): Promise<HttpClaim> => {
	const v = (await (await fetch(`${BASE}/roll`)).json()) as {
		claims: HttpClaim[];
	};
	const hit = v.claims.find((c) => c.evidenceId === ev);
	expect(hit).toBeTruthy();
	return hit as HttpClaim;
};

const up = async (): Promise<boolean> =>
	fetch(`${BASE}/health`)
		.then((r) => r.ok)
		.catch(() => false);

test("roll api boots on loopback", async () => {
	for (let i = 0; i < 60 && !(await up()); i++) await Bun.sleep(150);
	expect(await up()).toBe(true);
});

const BODY_A = {
	evidenceId: "ev-http-a",
	claim: "http convergence claim a",
	confidence: 0.8,
};

test("FAIL61611 on the wire: dupe assert carries time, stale tomb cannot hide", async () => {
	expect((await roll([{ ...BODY_A, ts: 100 }], "m-a")).counts?.versions).toBe(
		1,
	);
	// identical payload, newer ts — deduped but the mark must move
	expect((await roll([{ ...BODY_A, ts: 500 }], "m-a")).counts?.dupes).toBe(1);
	// stale tomb 400 slides in behind the dupe: the gate holds, claim stays
	expect(
		(await roll([{ ...BODY_A, ts: 400, tombstone: true }], "m-b")).counts
			?.stale,
	).toBe(1);
	expect((await claimView("ev-http-a")).tombstone).toBe(false);
});

const BODY_B = {
	evidenceId: "ev-http-b",
	claim: "http convergence claim b",
	confidence: 0.8,
};

test("reverse order converges visible; re-push stays provenance-exact", async () => {
	expect(
		(await roll([{ ...BODY_B, ts: 400, tombstone: true }], "m-b")).counts
			?.tombstoned,
	).toBe(1);
	expect((await roll([{ ...BODY_B, ts: 100 }], "m-a")).counts?.stale).toBe(1);
	expect((await roll([{ ...BODY_B, ts: 500 }], "m-a")).counts?.merged).toBe(1);
	expect((await claimView("ev-http-b")).tombstone).toBe(false);
	// exact re-push of the revive: dupe, one provenance entry, no churn
	expect((await roll([{ ...BODY_B, ts: 500 }], "m-a")).counts?.dupes).toBe(1);
	expect((await claimView("ev-http-b")).provenanceCount).toBe(1);
});
