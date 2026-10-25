// knowledge-sink.test.ts — W1217.1: the NAS SINK proof. W1213.4 verified the
// assembled claim-roll contract through the production bin; the parent
// W1217 landed the sink CONFIG (compose knowledge-sink + knowledge-health)
// without exercising it — FAIL61547: config-only, no actual knowledge-api
// roll. This closes the actual part: one real knowledge-api process standing
// in for the NAS sink, two machines minting per-machine TTL keys and rolling
// over real HTTP — aggregate search (the confidence-ranked /roll view plus
// the /search card face), tenant private/foreign read boundary, rejected
// roll never acks, stale tombstone replay, RESTART persistence on the same
// SQLite volume, and the OUTSIDE health probe (deploy/healthcheck/probe.ts
// sidecar) vouching across the whole window — a wedged server cannot paint
// itself healthy (owner law 2026-10-05).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLL_KEY_HEADER } from "../hooks/lib/knowledge-roll.ts";
import { postRoll, type SyncTarget } from "../hooks/lib/knowledge-sync.ts";
import { unusedPort } from "./helpers/board-fixture.ts";

const HOME = mkdtempSync(join(tmpdir(), "w12171-sink-home-"));
const GOVDB_TS = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const STORE_TS = join(import.meta.dir, "..", "hooks", "lib", "sqlite-store.ts");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const PROBE_TS = join(
	import.meta.dir,
	"..",
	"deploy",
	"healthcheck",
	"probe.ts",
);
const KEYS_FILE = join(HOME, "roll-keys.json");
const PORT = unusedPort();
const HEALTH_PORT = unusedPort();
const BASE = `http://127.0.0.1:${PORT}`;

// seed through the REAL migration path (HOME-isolated): openGovernorDb mints
// the install write token + creates knowledge.db — the sink's one store.
const seedScript = [
	"const { openGovernorDb, openKnowledgeDb } = await import(process.env.W_GOVDB);",
	"openGovernorDb();",
	"openKnowledgeDb();",
	// one knowledge CARD through the real store port — the /search face's row
	"const { makeStore } = await import(process.env.W_STORE);",
	"await makeStore().upsert({topic: 'w12171 sink card', fact: 'sink card uniquely-named-abc123', confidence: 0.6, domain: null, area: null, originKind: null, originSystem: null, sourceRef: null, sourceHash: null, originSid: null, supersedesId: null});",
	"console.log('seeded');",
].join("\n");
const seed = Bun.spawnSync(["bun", "-e", seedScript], {
	env: { ...process.env, HOME, W_GOVDB: GOVDB_TS, W_STORE: STORE_TS },
	stdout: "pipe",
	stderr: "pipe",
});
if (!seed.stdout.toString().includes("seeded"))
	console.error("seed failed:", seed.stderr.toString(), seed.stdout.toString());

// two per-machine TTL keys minted ON this dev hub exactly as a spoke would —
// the key binds the provenance machine on every roll.
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

const sinkEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	HOME,
	KNOWLEDGE_API_PORT: String(PORT),
	SUSPENDERS_ROLL_KEYS_FILE: KEYS_FILE,
});
const spawnSink = (): Bun.Subprocess =>
	Bun.spawn(["bun", API_TS], {
		env: sinkEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
let sink = spawnSink();

// the OUTSIDE probe (the knowledge-health sidecar, exactly what compose
// runs): polls the sink's /status over the network, serves the verdict on
// its OWN port. Fast cadence so the restart window stays observable.
const probe = Bun.spawn(
	[
		"bun",
		PROBE_TS,
		"--target",
		`${BASE}/status`,
		"--listen",
		String(HEALTH_PORT),
		"--every",
		"150",
		"--timeout",
		"500",
		"--misses",
		"2",
	],
	{ env: { ...process.env, HOME }, stdout: "pipe", stderr: "pipe" },
);

afterAll(() => {
	sink.kill();
	probe.kill();
	rmSync(HOME, { recursive: true, force: true });
});

const token = (): string =>
	readFileSync(
		join(HOME, ".cache", "claude-governor", "write-token"),
		"utf8",
	).trim();
const keyOf = (machine: string): string =>
	readFileSync(join(HOME, `roll-key-${machine}.secret`), "utf8").trim();
// the sink process mints the write token at ITS boot — read lazily
const TOKEN_HEADER = (): Record<string, string> => ({
	"x-klh-write-token": token(),
});

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

interface SinkClaim {
	evidenceId: string;
	tombstone: boolean;
	scope: string;
	provenanceCount: number;
	provenance: { machine: string; ts: number; retract?: boolean }[];
}

/** the bounded keyed read (a spoke's view) and the operator full view. */
const keyedView = async (machine: string): Promise<{ claims: SinkClaim[] }> =>
	(await (
		await fetch(`${BASE}/roll`, {
			headers: { [ROLL_KEY_HEADER]: keyOf(machine) },
		})
	).json()) as { claims: SinkClaim[] };
const fullView = async (): Promise<{ claims: SinkClaim[] }> =>
	(await (await fetch(`${BASE}/roll`, { headers: TOKEN_HEADER() })).json()) as {
		claims: SinkClaim[];
	};

/** poll until fn() is true or ms elapse (restarts are async). */
const waitFor = async (fn: () => Promise<boolean>, ms: number) => {
	for (let t = 0; t < ms; t += 150) {
		if (await fn()) return true;
		await Bun.sleep(150);
	}
	return fn();
};
const sinkUp = (): Promise<boolean> =>
	fetch(`${BASE}/health`)
		.then((r) => r.ok)
		.catch(() => false);
const probeOk = (): Promise<boolean> =>
	fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`)
		.then((r) => r.ok)
		.catch(() => false);

test("the sink boots and the OUTSIDE probe vouches for it", async () => {
	expect(await waitFor(sinkUp, 10_000)).toBe(true);
	// the probe rides its own port/process — poll until its FIRST sample lands
	expect(await waitFor(probeOk, 10_000)).toBe(true);
	const verdict = (await (
		await fetch(`http://127.0.0.1:${HEALTH_PORT}/status`)
	).json()) as { state: string; ok: boolean; target: string };
	expect(verdict.state).toBe("up");
	expect(verdict.ok).toBe(true);
	// it polls the SINK over the wire, not itself
	expect(verdict.target).toContain(`${PORT}/status`);
});

// ─── two-machine rolls: the aggregate search face ───────────────────────────

const FLEET_CLAIM = {
	evidenceId: "ev-sink-fleet",
	claim: "sink aggregate fleet claim",
	confidence: 0.8,
	scope: "fleet",
};

test("two machines roll; the aggregate ranks and counts provenance", async () => {
	expect(
		(await roll([{ ...FLEET_CLAIM, ts: 100 }], "machine-a")).body.counts
			?.versions,
	).toBe(1);
	expect(
		(await roll([{ ...FLEET_CLAIM, ts: 101 }], "machine-b")).body.counts
			?.merged,
	).toBe(1);
	const view = await fullView();
	const row = view.claims.find((c) => c.evidenceId === "ev-sink-fleet");
	expect(row?.provenanceCount).toBe(2);
	expect(row?.provenance.map((p) => p.machine).sort()).toEqual([
		"machine-a",
		"machine-b",
	]);
	// the aggregate search is confidence-ranked: a higher-confidence claim
	// served later lands ABOVE the fleet row
	expect(
		(
			await roll(
				[
					{
						evidenceId: "ev-sink-top",
						claim: "highest confidence",
						confidence: 0.95,
						ts: 100,
						scope: "fleet",
					},
				],
				"machine-b",
			)
		).body.counts?.versions,
	).toBe(1);
	const ranked = (await fullView()).claims.map((c) => c.evidenceId);
	expect(ranked.indexOf("ev-sink-top")).toBeLessThan(
		ranked.indexOf("ev-sink-fleet"),
	);
});

test("tenant private/foreign read boundary at the sink (W1213.1)", async () => {
	expect(
		(
			await roll(
				[
					{
						evidenceId: "ev-sink-priv",
						claim: "machine-a private",
						confidence: 0.7,
						ts: 100,
						scope: "machine",
					},
				],
				"machine-a",
			)
		).body.counts?.versions,
	).toBe(1);
	const aView = await keyedView("machine-a");
	expect(
		aView.claims.find((c) => c.evidenceId === "ev-sink-priv"),
	).toBeTruthy();
	const bView = await keyedView("machine-b");
	expect(bView.claims.find((c) => c.evidenceId === "ev-sink-priv")).toBe(
		undefined,
	);
	// the fleet plane crosses machines
	expect(
		bView.claims.find((c) => c.evidenceId === "ev-sink-fleet"),
	).toBeTruthy();
});

test("a rejected roll never acks (W1213.2 on the sink)", async () => {
	const bad = await roll(
		[
			{
				evidenceId: "ev-sink-bad",
				claim: "invalid confidence",
				confidence: 2,
				ts: 1,
				scope: "fleet",
			},
		],
		"machine-a",
	);
	expect(bad.status).toBe(422);
	// the client seam: rejection surfaces in the outcome, cursor keeps
	const target: SyncTarget = {
		url: BASE,
		writeTokenFile: join(HOME, "hub.token"),
		rollUrl: BASE,
		rollKeyFile: join(HOME, "roll-key-machine-a.secret"),
	};
	const outcome = await postRoll(target, [
		{
			evidenceId: "ev-sink-bad2",
			claim: "still invalid",
			confidence: 2,
			ts: 2,
			scope: "fleet",
		},
	]);
	expect(outcome.ok).toBe(false);
	expect(outcome.error).toContain("422");
	expect(
		(await fullView()).claims.filter((c) =>
			c.evidenceId.startsWith("ev-sink-bad"),
		),
	).toHaveLength(0);
});

test("a stale tombstone cannot hide the claim (W1213.3 on the sink)", async () => {
	const ev = {
		evidenceId: "ev-sink-tomb",
		claim: "sink tombstone claim",
		confidence: 0.8,
		scope: "fleet",
	};
	expect(
		(await roll([{ ...ev, ts: 100 }], "machine-a")).body.counts?.versions,
	).toBe(1);
	expect(
		(await roll([{ ...ev, ts: 200, tombstone: true }], "machine-b")).body.counts
			?.tombstoned,
	).toBe(1);
	expect(
		(await roll([{ ...ev, ts: 300 }], "machine-a")).body.counts?.merged,
	).toBe(1);
	// the 200 tombstone replay: stale — the claim stays served
	const replay = await roll([{ ...ev, ts: 200, tombstone: true }], "machine-b");
	expect(replay.body.counts?.stale).toBe(1);
	const row = (await fullView()).claims.find(
		(c) => c.evidenceId === "ev-sink-tomb",
	);
	expect(row?.tombstone).toBe(false);
	expect(row?.provenanceCount).toBe(2);
});

test("the sink serves the /search card face from the same store", async () => {
	// the card was seeded through the REAL store port in the seed child —
	// the /search face serves it; anonymous output is scrubbed (no source refs)
	const search = await fetch(`${BASE}/search`, {
		method: "POST",
		headers: { "content-type": "application/json", ...TOKEN_HEADER() },
		body: JSON.stringify({ query: "uniquely-named-abc123" }),
	});
	const found = (await search.json()) as {
		hits: { topic: string; source_ref?: string }[];
	};
	expect(found.hits.length).toBeGreaterThan(0);
	// anonymous reads stay scrubbed
	const anon = await fetch(`${BASE}/search`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "uniquely-named-abc123" }),
	});
	const anonHits = (await anon.json()) as {
		hits: Record<string, unknown>[];
	};
	expect(anonHits.hits.length).toBeGreaterThan(0);
	expect(anonHits.hits.some((h) => "source_ref" in h)).toBe(false);
});

// ─── persistence: the SQLite volume outlives the process ────────────────────

test("the aggregate and keys survive a sink RESTART on the same volume", async () => {
	const before = await fullView();
	sink.kill();
	await sink.exited;
	sink = spawnSink();
	expect(await waitFor(sinkUp, 20_000)).toBe(true);
	// every claim — including per-machine private rows — rides the volume
	const after = await fullView();
	expect(after.claims.length).toBe(before.claims.length);
	for (const b of before.claims) {
		const a = after.claims.find((c) => c.evidenceId === b.evidenceId);
		expect(a?.provenanceCount).toBe(b.provenanceCount);
		expect(a?.tombstone).toBe(b.tombstone);
	}
	// the minted TTL key still validates against the SAME keys file
	expect(
		(await keyedView("machine-b")).claims.find(
			(c) => c.evidenceId === "ev-sink-priv",
		),
	).toBeUndefined();
	// rolls CONTINUE: a new assertion merges provenance onto the old row
	expect(
		(await roll([{ ...FLEET_CLAIM, ts: 102 }], "machine-a")).body.counts?.dupes,
	).toBe(1);
	const revived = (await fullView()).claims.find(
		(c) => c.evidenceId === "ev-sink-fleet",
	);
	expect(revived?.provenanceCount).toBe(2);
	// the outside probe recovers (or never fell — either way it vouches again
	// once the sink returns)
	expect(await waitFor(probeOk, 15_000)).toBe(true);
	const verdict = (await (
		await fetch(`http://127.0.0.1:${HEALTH_PORT}/status`)
	).json()) as { state: string };
	expect(verdict.state).toBe("up");
});
