// knowledge-api-hardening.test.ts — W181 F2 teeth (W203): the aux-store scope
// predicates in knowledgeSearch, the anonymous scrub on /search + /verify,
// and the host/token gate on the live HTTP face. Lib tests run against a
// seeded in-memory DB shaped like the real migrations; the API test spawns
// the real bin with an isolated temp HOME + repo (evidence over mocks).
import { expect, test } from "./pw";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { tmpDir } from "./helpers/fixture-kit.ts";
import { knowledgeSearch, proseCards } from "../hooks/lib/knowledge/knowledge.ts";
import { unusedPort } from "./helpers/board-fixture.ts";

// ─── lib-level: scope predicates on the aux stores (W181 F2/M7) ───
const db = new Database(":memory:");
db.run(
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER)",
);
db.run(
	"CREATE VIRTUAL TABLE knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')",
);
db.run(
	"CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
);
db.run(
	"CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END",
);
db.run(
	"CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
);
db.run(
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL, confidence REAL, confidence_stamp TEXT)",
);
db.run("CREATE VIRTUAL TABLE facts_fts USING fts5(value, key UNINDEXED)");
db.run(
	"CREATE TRIGGER facts_fts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
);
db.run(
	"CREATE TABLE consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, asked_by TEXT NOT NULL, answered_by TEXT NOT NULL, consult_id INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL, confidence REAL, confidence_stamp TEXT)",
);
db.run("CREATE VIRTUAL TABLE consult_kb_fts USING fts5(problem)");

const NOW = Date.now();
db.run(
	"INSERT INTO knowledge (ts, topic, fact, confidence, domain, area, origin_kind, state) VALUES (?, ?, ?, 0.9, 'suspenders', 'gate', 'decision', 'active')",
	[
		NOW,
		"w203 alpha public anchor",
		"The w203 alpha anchor teaches scoped search honesty. w203zq",
	],
);
db.run(
	"INSERT INTO knowledge (ts, topic, fact, confidence, domain, state) VALUES (?, ?, ?, 0.9, 'buckle', 'active')",
	[
		NOW,
		"w203 beta buckle anchor",
		"The w203 beta anchor lives in the buckle domain. w203zq",
	],
);
db.run(
	"INSERT INTO facts (key, value, source, version, ts) VALUES ('finding.w203private', 'PRIVATE w203 intel alpha w203zq', 'seed', 1, ?)",
	[NOW],
);
db.run(
	"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, created_at) VALUES ('how to alpha seed a lease release w203zq', 'release via lease-release then re-take', 'suspenders', 'a', 'b', ?)",
	[NOW],
);
db.run(
	"INSERT INTO consult_kb_fts (rowid, problem) SELECT id, problem FROM consult_kb",
);

const kinds = (hits: { kind: string }[]): string[] =>
	[...new Set(hits.map((h) => h.kind))].sort();

test.describe("knowledgeSearch scope predicates (W181 F2)", () => {
	test("unscoped search still serves all three stores", () => {
		const out = knowledgeSearch(db, "w203zq");
		expect(kinds(out)).toEqual(["consult_kb", "fact", "knowledge"]);
	});

	test("domain-scoped: facts excluded, consult matches on project, knowledge filters", () => {
		const out = knowledgeSearch(db, "w203zq", { domain: "suspenders" });
		expect(kinds(out)).toEqual(["consult_kb", "knowledge"]);
		expect(out.some((h) => h.kind === "fact")).toBe(false);
	});

	test("domain with no matching consult project returns knowledge only", () => {
		const out = knowledgeSearch(db, "w203zq", { domain: "buckle" });
		expect(kinds(out)).toEqual(["knowledge"]);
	});

	test("area-scoped search excludes BOTH aux stores (no such tags)", () => {
		const out = knowledgeSearch(db, "w203zq", { area: "gate" });
		expect(kinds(out)).toEqual(["knowledge"]);
	});

	test("originKind filter also excludes aux stores", () => {
		const out = knowledgeSearch(db, "w203zq", { originKind: "decision" });
		expect(kinds(out)).toEqual(["knowledge"]);
	});

	test("retired knowledge rows stay out (predicate kept intact)", () => {
		db.run("UPDATE knowledge SET state = 'retired' WHERE domain = 'buckle'");
		const out = knowledgeSearch(db, "anchor", { domain: "buckle" });
		expect(out).toEqual([]);
		db.run("UPDATE knowledge SET state = 'active' WHERE domain = 'buckle'");
	});
});

test.describe("proseCards honors precomputed trust", () => {
	test("scrubbed hit (refs stripped) keeps its computed trust state", () => {
		const cards = proseCards(
			"w203zq",
			[
				{
					kind: "knowledge",
					id: 7,
					ts: NOW,
					snippet: "",
					topic: "w203 trust anchor",
					fact: "The w203 trust anchor fact. w203zq",
					state: "active",
					ageDays: 1,
					source_ref: null,
					source_hash: null,
					trust: "verified",
				},
			],
			"/nonexistent-root",
		);
		expect(cards).toContain("hash verified");
		expect(cards).toContain("source: none");
	});
});

// ─── API-level: the live HTTP face (spawn the real bin) ───
const HOME = tmpDir("w203-api-home-");
const REPO = tmpDir("suspenders-w203-api-repo-");
mkdirSync(join(REPO, "docs"), { recursive: true });
const DOC_TEXT =
	"w203 trust anchor doc: hashes must verify mechanically. w203zq";
writeFileSync(join(REPO, "docs", "w203-trust-doc.md"), DOC_TEXT);
const DOC_HASH = createHash("sha256").update(DOC_TEXT).digest("hex");
const GOVDB_TS = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"govdb",
	"govdb.ts",
);
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const PORT = unusedPort();
const BASE = `http://127.0.0.1:${PORT}`;

// seed through the REAL migration path in a subprocess (HOME-isolated):
// openGovernorDb runs v1..v10 → creates knowledge.db (split) + facts/consult_kb
const seedScript = [
	"const { openGovernorDb, openKnowledgeDb } = await import(process.env.W203_GOVDB);",
	"const gov = openGovernorDb();",
	"const kb = openKnowledgeDb();",
	"const now = Date.now();",
	"kb.run(\"INSERT INTO knowledge (ts, topic, fact, confidence, domain, state, source_ref, source_hash, created_at, updated_at) VALUES (?, ?, ?, 0.9, 'suspenders', 'active', 'docs/w203-trust-doc.md', ?, ?, ?)\",",
	"  [now, 'w203 trust anchor alpha', 'The w203 trust anchor alpha row: refs disclose repo layout. w203zq', process.env.W203_DOC_HASH, now, now]);",
	"gov.run(\"INSERT INTO facts (key, value, source, version, ts) VALUES ('finding.w203private', 'PRIVATE w203 intel alpha w203zq', 'seed', 1, ?)\", [now]);",
	"gov.run(\"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, created_at) VALUES ('how to alpha seed a lease release w203zq', 'release via lease-release then re-take', 'suspenders', 'a', 'b', ?)\", [now]);",
	"gov.run('INSERT INTO consult_kb_fts (rowid, problem) SELECT id, problem FROM consult_kb');",
	"console.log('seeded');",
].join("\n");

const seed = Bun.spawnSync(["bun", "-e", seedScript], {
	env: { ...process.env, HOME, W203_GOVDB: GOVDB_TS, W203_DOC_HASH: DOC_HASH },
	stdout: "pipe",
	stderr: "pipe",
});
if (!seed.stdout.toString().includes("seeded")) {
	console.error("seed failed:", seed.stderr.toString(), seed.stdout.toString());
}

const proc = Bun.spawn(["bun", API_TS], {
	env: { ...process.env, HOME, KNOWLEDGE_API_PORT: String(PORT) },
	cwd: REPO,
	stdout: "pipe",
	stderr: "pipe",
});

const search = async (
	body: Record<string, unknown>,
	token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> => {
	const res = await fetch(`${BASE}/search`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { "x-klh-write-token": token } : {}),
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		data: (await res.json()) as Record<string, unknown>,
	};
};

// W1213.1: /roll roundtrip helpers — the same spawned server, real HTTP.
const rollFetch = async (
	method: "GET" | "POST",
	body?: Record<string, unknown>,
	key?: string,
): Promise<{ status: number; data: Record<string, unknown> }> => {
	const res = await fetch(`${BASE}/roll`, {
		method,
		headers: {
			"content-type": "application/json",
			...(key ? { "x-klh-roll-key": key } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		status: res.status,
		data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
	};
};

// the REAL mint face: a subprocess of the same bin, same isolated HOME, so
// the server and the tests share one 0600 key file.
const mintKey = (machine: string): string => {
	const r = Bun.spawnSync(
		["bun", API_TS, "--mint-roll-key", machine, "--ttl-hours", "1"],
		{ env: { ...process.env, HOME }, stdout: "pipe", stderr: "pipe" },
	);
	return (JSON.parse(r.stdout.toString()) as { key: string }).key;
};
const KEY_A = mintKey("machine-a");
const KEY_B = mintKey("machine-b");

test.afterAll(() => {
	proc.kill();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test.describe("knowledge-api live face (W181 F2)", () => {
	test("health is explicit and unknown routes never masquerade as healthy", async () => {
		for (let i = 0; i < 60; i++) {
			if (
				await fetch(`${BASE}/health`)
					.then((r) => r.ok)
					.catch(() => false)
			)
				break;
			await Bun.sleep(150);
		}
		expect((await fetch(`${BASE}/health`)).status).toBe(200);
		expect(
			await (await fetch(`${BASE}/health`, { method: "HEAD" })).text(),
		).toBe("");
		expect((await fetch(`${BASE}/health`, { method: "DELETE" })).status).toBe(
			405,
		);
		expect((await fetch(`${BASE}/health/liveliness`)).status).toBe(404);
		expect((await fetch(`${BASE}/api/status`)).status).toBe(404);
	});
	const token = (): string =>
		readFileSync(
			join(HOME, ".cache", "claude-governor", "write-token"),
			"utf8",
		).trim();

	test("boots on loopback with seeded corpus", async () => {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			up = await fetch(`${BASE}/verify`)
				.then((r) => r.ok)
				.catch(() => false);
			if (!up) await Bun.sleep(150);
		}
		expect(up).toBe(true);
	});

	test("spoofed Host is rejected on a READ route (DNS-rebind defense)", () => {
		const r = Bun.spawnSync([
			"curl",
			"-sS",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code}",
			"-X",
			"POST",
			`${BASE}/search`,
			"-H",
			"Host: evil.example",
			"-H",
			"content-type: application/json",
			"-d",
			'{"query":"w203zq"}',
		]);
		expect(r.stdout.toString()).toBe("403");
	});

	test("anonymous /search: refs and hashes scrubbed, trust state kept", async () => {
		const { data } = await search({ query: "w203zq" });
		const hits = data.hits as Record<string, unknown>[];
		expect(hits.length).toBeGreaterThan(0);
		const k = hits.find((h) => h.kind === "knowledge");
		expect(k).toBeTruthy();
		expect("source_ref" in k).toBe(false);
		expect("source_hash" in k).toBe(false);
		expect("code_origin" in k).toBe(false);
		expect(k.trust).toBe("verified");
		const cards = data.cards as string;
		expect(cards).toContain("source: none");
		expect(cards).not.toContain("docs/w203-trust-doc.md");
	});

	test("tokened /search: refs disclosed, trust verified", async () => {
		const { data } = await search({ query: "w203zq" }, token());
		const hits = data.hits as Record<string, unknown>[];
		const k = hits.find((h) => h.kind === "knowledge");
		expect(k.source_ref).toBe("docs/w203-trust-doc.md");
		expect(k.trust).toBe("verified");
		expect(data.cards as string).toContain("docs/w203-trust-doc.md");
	});

	test("anonymous /search cannot steer the trust root via repo param", async () => {
		const { data } = await search({ query: "w203zq", repo: "/etc" });
		const hits = data.hits as Record<string, unknown>[];
		const k = hits.find((h) => h.kind === "knowledge");
		expect(k.trust).toBe("verified"); // resolved against the API root, not /etc
		expect("source_ref" in k).toBe(false);
	});

	test("/verify: anonymous gets id+topic only; token unlocks refs", async () => {
		const anonRows = (
			(await (await fetch(`${BASE}/verify`)).json()) as {
				rows: Record<string, unknown>[];
			}
		).rows;
		expect(anonRows.length).toBeGreaterThan(0);
		for (const r of anonRows) {
			expect(Object.keys(r).sort()).toEqual(["id", "topic"]);
		}
		const authRows = (
			(await (
				await fetch(`${BASE}/verify`, {
					headers: { "x-klh-write-token": token() },
				})
			).json()) as { rows: Record<string, unknown>[] }
		).rows;
		expect(authRows[0].sourceRef).toBe("docs/w203-trust-doc.md");
	});

	// W189: the domain axis through the LIVE face. A scope filter must never
	// surface rows the axis cannot gate (W181 F2 predicate). Post-W166 split
	// face: facts + consult_kb ride governor.db behind dedicated faces (coord
	// fact verbs / consult kbSearch) — /search serves knowledge rows only, so
	// the scoped face serves the knowledge domain subset and nothing leaks.
	test("domain-scoped /search: no aux rows, the axis filters knowledge", async () => {
		const scoped = await search({ query: "w203zq", domain: "suspenders" });
		const hits = scoped.data.hits as Record<string, unknown>[];
		expect(hits.map((h) => h.kind)).toEqual(["knowledge"]);
		// the axis bites: a domain with no matching rows serves nothing
		const empty = await search({ query: "w203zq", domain: "buckle" });
		expect(empty.status).toBe(200);
		expect(empty.data.hits).toEqual([]);
	});
});

test.describe("POST/GET /roll scope boundary (W1213.1)", () => {
	const fleetEntry = {
		evidenceId: "w12131-ev-fleet",
		claim: "boundary fleet assertion",
		confidence: 0.6,
		ts: 100,
		scope: "fleet",
	};
	test("unknown scope fails closed over real HTTP", async () => {
		const p = await rollFetch(
			"POST",
			{ claims: [{ ...fleetEntry, scope: "unknown-private-scope" }] },
			KEY_A,
		);
		expect(p.status).toBe(422);
	});

	test("anonymous read AND write are refused", async () => {
		const g = await rollFetch("GET");
		expect(g.status).toBe(403);
		expect(g.data.claims).toBeUndefined();
		const p = await rollFetch("POST", { claims: [fleetEntry] });
		expect(p.status).toBe(403);
	});

	test("missing scope and unknown entry fields fail closed", async () => {
		const noScope = await rollFetch(
			"POST",
			{
				claims: [{ ...fleetEntry, scope: undefined as unknown as string }],
			},
			KEY_A,
		);
		expect(noScope.status).toBe(422);
		const extra = await rollFetch(
			"POST",
			{ claims: [{ ...fleetEntry, tenant: "machine-z" }] },
			KEY_A,
		);
		expect(extra.status).toBe(422);
	});

	test("machine-scoped claim: origin reads it, foreign machine cannot", async () => {
		const priv = {
			evidenceId: "w12131-ev-priv",
			claim: "private to machine-a",
			confidence: 0.7,
			ts: 150,
			scope: "machine",
		};
		const put = await rollFetch("POST", { claims: [priv] }, KEY_A);
		expect(put.status).toBe(200);
		const bView = await rollFetch("GET", undefined, KEY_B);
		const bClaims = bView.data.claims as { evidenceId: string }[];
		expect(bClaims.some((c) => c.evidenceId === priv.evidenceId)).toBe(false);
		const aView = await rollFetch("GET", undefined, KEY_A);
		const aClaims = aView.data.claims as { evidenceId: string }[];
		expect(aClaims.some((c) => c.evidenceId === priv.evidenceId)).toBe(true);
	});

	test("W1213.1.1: foreign public re-assertion cannot widen a private row", async () => {
		const priv = {
			evidenceId: "w121311-ev-leak",
			claim: "tenant-a private finding",
			confidence: 0.7,
			ts: 300,
			scope: "machine",
		};
		// tenant-a keeps the claim private (machine scope)
		const put = await rollFetch("POST", { claims: [priv] }, KEY_A);
		expect(put.status).toBe(200);
		// tenant-b's initial read: the private row is invisible (read 0)
		const before = await rollFetch("GET", undefined, KEY_B);
		expect(
			(before.data.claims as { evidenceId: string }[]).some(
				(c) => c.evidenceId === priv.evidenceId,
			),
		).toBe(false);
		// tenant-b self-asserts the SAME content at fleet scope
		const self = await rollFetch(
			"POST",
			{ claims: [{ ...priv, ts: 400, scope: "fleet" }] },
			KEY_B,
		);
		expect(self.status).toBe(200);
		const selfLands = self.data.counts as { versions: number; merged: number };
		expect(selfLands.versions).toBe(1); // a separate NEW row — not a merge
		expect(selfLands.merged).toBe(0);
		// tenant-b's post-assertion read: still no machine-a private row —
		// only its own fleet row, carrying only machine-b provenance
		const after = await rollFetch("GET", undefined, KEY_B);
		const foreign = (
			after.data.claims as {
				evidenceId: string;
				scope: string;
				originMachine: string;
				provenance: { machine: string }[];
			}[]
		).filter((c) => c.evidenceId === priv.evidenceId);
		expect(foreign).toHaveLength(1);
		expect(foreign[0]?.scope).toBe("fleet");
		expect(foreign[0]?.originMachine).toBe("machine-b");
		expect(foreign[0]?.provenance.every((p) => p.machine === "machine-b")).toBe(
			true,
		);
		// the stored state: the hub SQLite rows prove the private row never
		// gained foreign provenance (the exact regression was SQLite-visible)
		const hub = new Database(
			join(HOME, ".cache", "claude-governor", "knowledge.db"),
			{ readonly: true },
		);
		try {
			const rows = hub
				.query(
					"SELECT scope, origin_machine, provenance FROM knowledge_claims WHERE evidence_id = ? ORDER BY id",
				)
				.all(priv.evidenceId) as {
				scope: string;
				origin_machine: string;
				provenance: string;
			}[];
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				scope: "machine",
				origin_machine: "machine-a",
			});
			expect(JSON.parse(rows[0]?.provenance ?? "[]")).toEqual([
				{ machine: "machine-a", ts: 300 },
			]);
			expect(rows[1]).toMatchObject({
				scope: "fleet",
				origin_machine: "machine-b",
			});
		} finally {
			hub.close();
		}
	});

	test("fleet claim rolls up across machines with provenance 2", async () => {
		const p1 = await rollFetch("POST", { claims: [fleetEntry] }, KEY_A);
		expect(p1.status).toBe(200);
		const p2 = await rollFetch("POST", { claims: [fleetEntry] }, KEY_B);
		expect(p2.status).toBe(200);
		const aView = await rollFetch("GET", undefined, KEY_A);
		const hit = (
			aView.data.claims as { evidenceId: string; provenanceCount: number }[]
		).find((c) => c.evidenceId === fleetEntry.evidenceId);
		expect(hit?.provenanceCount).toBe(2);
	});

	test("invalid confidence is a 422, never a silent ok:false 200", async () => {
		const bad = await rollFetch(
			"POST",
			{
				claims: [
					{ ...fleetEntry, confidence: 99, evidenceId: "w12131-ev-bad" },
				],
			},
			KEY_A,
		);
		expect(bad.status).toBe(422);
		const view = await rollFetch("GET", undefined, KEY_A);
		const claims = view.data.claims as { evidenceId: string }[];
		expect(claims.some((c) => c.evidenceId === "w12131-ev-bad")).toBe(false);
	});
});
