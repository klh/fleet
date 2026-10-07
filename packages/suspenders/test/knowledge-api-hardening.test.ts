// knowledge-api-hardening.test.ts — W181 F2 teeth (W203): the aux-store scope
// predicates in knowledgeSearch, the anonymous scrub on /search + /verify,
// and the host/token gate on the live HTTP face. Lib tests run against a
// seeded in-memory DB shaped like the real migrations; the API test spawns
// the real bin with an isolated temp HOME + repo (evidence over mocks).
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { knowledgeSearch, proseCards } from "../hooks/lib/knowledge.ts";

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
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
);
db.run("CREATE VIRTUAL TABLE facts_fts USING fts5(value, key UNINDEXED)");
db.run(
	"CREATE TRIGGER facts_fts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
);
db.run(
	"CREATE TABLE consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, asked_by TEXT NOT NULL, answered_by TEXT NOT NULL, consult_id INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL)",
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

describe("knowledgeSearch scope predicates (W181 F2)", () => {
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

describe("proseCards honors precomputed trust", () => {
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
const HOME = mkdtempSync(join(tmpdir(), "w203-api-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-w203-api-repo-"));
mkdirSync(join(REPO, "docs"), { recursive: true });
const DOC_TEXT =
	"w203 trust anchor doc: hashes must verify mechanically. w203zq";
writeFileSync(join(REPO, "docs", "w203-trust-doc.md"), DOC_TEXT);
const DOC_HASH = createHash("sha256").update(DOC_TEXT).digest("hex");
const GOVDB_TS = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const PORT = 7869 + (process.pid % 8);
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

afterAll(() => {
	proc.kill();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("knowledge-api live face (W181 F2)", () => {
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
