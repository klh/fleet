import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	approxTok,
	buckleLaneTokens,
	measureBriefWeight,
	pkgAgentFiles,
} from "../scripts/lib/brief-weight.ts";

// W633: the instruction-weight audit lib — static injection measurement
// (brief boilerplate probe + AGENTS.md chain + harness rules) and the real
// per-lane in_tok join off the buckle ledger.

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test("approxTok: chars/4 ceil", () => {
	expect(approxTok("abcd")).toBe(1);
	expect(approxTok("abc")).toBe(1);
	expect(approxTok("")).toBe(0);
});

test("pkgAgentFiles: heaviest-first, missing files skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-bw-"));
	roots.push(root);
	mkdirSync(join(root, "packages/alpha"), { recursive: true });
	mkdirSync(join(root, "packages/beta"), { recursive: true });
	writeFileSync(join(root, "packages/alpha/AGENTS.md"), "x".repeat(400));
	writeFileSync(join(root, "packages/beta/AGENTS.md"), "y".repeat(100));
	expect(pkgAgentFiles(root)).toEqual([
		"packages/alpha/AGENTS.md",
		"packages/beta/AGENTS.md",
	]);
	writeFileSync(join(root, "packages/beta/OTHER.md"), "z");
	expect(pkgAgentFiles(root)).toEqual([
		"packages/alpha/AGENTS.md",
		"packages/beta/AGENTS.md",
	]);
});

test("buckleLaneTokens: joins router_usage to api_keys by key_hash prefix", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-bw-"));
	roots.push(root);
	const dbPath = join(root, "buckle.db");
	const db = new Database(dbPath);
	db.exec(`CREATE TABLE router_usage (
		hour_bucket TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
		model_group TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
		in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
		cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0,
		requests INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (hour_bucket, key, model_group, model));
	CREATE TABLE api_keys (
		key_id TEXT, key_hash TEXT, name TEXT, created_at INTEGER);`);
	db.query(
		`INSERT INTO api_keys (key_id, key_hash, name, created_at) VALUES (?, ?, ?, ?)`,
	).run("k1", "aaa999xxxxxx-full-sha", "autow1-test", 1);
	db.query(`INSERT INTO router_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		"2026-10-10T10",
		"aaa999xxxxxx",
		"m",
		"m",
		1200,
		100,
		400,
		0,
		2,
	);
	// old bucket — outside the 7d window, must not count
	db.query(`INSERT INTO router_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		"2026-09-01T10",
		"aaa999xxxxxx",
		"m",
		"m",
		99000,
		1,
		0,
		0,
		1,
	);
	db.close();
	const rows = buckleLaneTokens(dbPath, 7, Date.UTC(2026, 9, 11, 12));
	expect(rows).toHaveLength(1);
	expect(rows[0].lane).toBe("autow1-test");
	expect(rows[0].inTok).toBe(1200);
	expect(rows[0].reqs).toBe(2);
	const wide = buckleLaneTokens(dbPath, 60, Date.UTC(2026, 9, 11, 12));
	expect(wide[0].inTok).toBe(100200);
	expect(buckleLaneTokens(join(root, "missing.db"), 7)).toEqual([]);
});

test("measureBriefWeight: reads the chain and sums per-lane static", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-bw-"));
	roots.push(root);
	writeFileSync(join(root, "AGENTS.md"), "a".repeat(800));
	mkdirSync(join(root, "packages/gamma"), { recursive: true });
	writeFileSync(join(root, "packages/gamma/AGENTS.md"), "b".repeat(400));
	const w = await measureBriefWeight(root);
	expect(w).not.toBeNull();
	if (!w) return;
	expect(w.brief).toBeGreaterThan(500);
	expect(w.rootAgents).toBe(200);
	expect(w.pkgAgents[0]?.file).toBe("packages/gamma/AGENTS.md");
	// harness is machine-local (reads the real ~/.claude) — only shape-check
	expect(w.perLaneStaticTok).toBeGreaterThanOrEqual(
		w.brief + (w.rootAgents ?? 0),
	);
});
