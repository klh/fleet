// distill-decant@unit.e2e.ts — fork G: decant.db as a graph source.
// A scratch decant.db built from decant's own schema.sql, opened READ-ONLY;
// sessions become reference-only nodes linked to project / files / tools /
// commands; a recurring command set lands as a Kev-gated `decant` candidate.
// Security: a session carrying fake key material and a home path leaves no
// key bytes in kg_nodes, kg_edges, knowledge, proposals, Kev input or the
// hub-sync export; decant.db bytes are untouched.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecant } from "../hooks/lib/knowledge/distill/decant.ts";
import { runOnce } from "../hooks/lib/knowledge/distill/runner.ts";
import { exportGraphDelta } from "../hooks/lib/knowledge/distill/sync.ts";
import {
	addDecantSession,
	decantDb,
	knowledgeDb,
	world,
} from "./fixtures/distill-world.ts";

// key material assembled at runtime so the committed spec carries none
const OPENAI = ["sk", "proj", "Zq8WvX2mN4bR7tY1uK9pL3sD6fG0hJ5cE"].join("-");
const GITHUB = `${"ghp"}_${"R4nd0mT0k3nV4lu3F0rT3st1ngOnly12345"}`;
const HOME = `/${"Users"}/alice-secret`;
const NEEDLES = [
	OPENAI,
	GITHUB,
	"Zq8WvX2mN4bR7tY1uK9pL3sD6fG0hJ5cE",
	"R4nd0mT0k3nV4lu3F0rT3st1ngOnly12345",
	"alice-secret",
];

const fileSha = (p) =>
	createHash("sha256").update(readFileSync(p)).digest("hex");

const dump = (db) =>
	JSON.stringify([
		db.query("SELECT * FROM kg_nodes").all(),
		db.query("SELECT * FROM kg_edges").all(),
		db.query("SELECT * FROM knowledge").all(),
		db.query("SELECT * FROM knowledge_proposals").all(),
		db.query("SELECT * FROM distill_clusters").all(),
		db.query("SELECT * FROM distill_visits").all(),
	]);

test("decant sessions → graph; recurring commands → Kev-gated decant candidate; no key bytes survive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distill-decant-"));
	const path = join(dir, "decant.db");
	const seed = decantDb(path);
	for (let i = 0; i < 3; i++)
		addDecantSession(seed, {
			sid: `s${i}`,
			project: "/repo/fleet",
			title:
				i === 0
					? `fix W2274.3 with token ${OPENAI}`
					: `session ${i} on packages/buckle/src/router-walk.ts`,
			branch: "main",
			files: [
				{ path: "/repo/fleet/packages/buckle/src/router-walk.ts", op: "edit" },
				{ path: "/repo/fleet/packages/buckle/test/walk.e2e.ts", op: "edit" },
				{ path: "/repo/fleet/README.md", op: "read" },
				...(i === 0
					? [{ path: `${HOME}/.config/${GITHUB}.json`, op: "read" }]
					: []),
			],
			commands: [
				"bun test packages/buckle",
				"qlty check --filter biome",
				...(i === 0
					? [
							`OPENAI_API_KEY=${OPENAI} curl -H "authorization: Bearer ${GITHUB}" ${HOME}/x`,
						]
					: []),
			],
			ingestedAt: `2026-10-2${i}T10:00:00Z`,
		});
	seed.close();
	const before = fileSha(path);
	const decant = openDecant(path);
	expect(decant).not.toBeNull();
	const db = knowledgeDb();
	const w = world(db, {
		logDir: dir,
		decant,
		cfg: { decant_script_min_sessions: 3 },
	});
	try {
		const r = await runOnce(w.deps, { jobs: ["decant"] });
		expect(r.outcome).toBe("ok");
		expect(r.items).toBe(3);

		const kinds = Object.fromEntries(
			db
				.query("SELECT kind, COUNT(*) AS n FROM kg_nodes GROUP BY kind")
				.all()
				.map((x) => [x.kind, x.n]),
		);
		expect(kinds.session).toBe(3);
		expect(kinds.project).toBe(1);
		expect(kinds.script).toBe(1);
		expect(kinds.command).toBeGreaterThanOrEqual(2);
		const types = db
			.query("SELECT DISTINCT type FROM kg_edges")
			.all()
			.map((x) => x.type);
		for (const t of [
			"touched",
			"edited",
			"co_changed",
			"uses",
			"part_of",
			"about",
		])
			expect(types).toContain(t);
		// sessions are reference-only: no transcript text, tagged decant + scrubbed
		for (const s of db
			.query("SELECT props FROM kg_nodes WHERE kind = 'session'")
			.all()) {
			const p = JSON.parse(s.props);
			expect(p.origin).toBe("decant");
			expect(p.scrubbed).toBe(true);
		}

		const cand = db
			.query(
				"SELECT state, origin_kind, source_ref, provenance FROM knowledge WHERE origin_kind = 'decant'",
			)
			.all();
		expect(cand.length).toBe(1);
		expect(cand[0].state).toBe("candidate");
		expect(cand[0].source_ref.startsWith("decant:session:")).toBe(true);
		expect(JSON.parse(cand[0].provenance).source_refs.length).toBe(2);
		expect(w.kevCalls.length).toBe(1);

		// SECURITY: no key / home-path bytes anywhere derived from decant
		const everything = `${dump(db)}${JSON.stringify(w.kevCalls)}${JSON.stringify(exportGraphDelta(db, 0))}`;
		for (const n of NEEDLES) expect(everything).not.toContain(n);
		// non-vacuous: the key-bearing rows WERE ingested, in redacted form
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM kg_nodes WHERE key LIKE '%[scrubbed:%'",
				)
				.get().n,
		).toBeGreaterThan(0);
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM kg_nodes WHERE label LIKE '%[scrubbed:sk-key]%'",
				)
				.get().n,
		).toBe(1);
		// hub export carries only scrubbed decant rows
		for (const n of exportGraphDelta(db, 0).nodes) {
			const p = n.props ?? {};
			if (p.origin === "decant") expect(p.scrubbed).toBe(true);
		}
		// a second pass is idempotent: the script signature is remembered
		db.run("DELETE FROM distill_visits");
		await runOnce(w.deps, { jobs: ["decant"] });
		expect(w.kevCalls.length).toBe(1);
	} finally {
		w.close();
		decant?.close();
	}
	// decant.db is never written
	expect(fileSha(path)).toBe(before);
	rmSync(dir, { recursive: true, force: true });
});

test("absent decant_db path is skipped, not an error", () => {
	expect(openDecant(undefined)).toBeNull();
	expect(openDecant("/nonexistent/decant.db")).toBeNull();
});
