// bench/w1219/e2e.ts — the /knowledge/query e2e. Spawns the REAL
// knowledge-api (the sink face) over a fresh replica of the sink's own
// knowledge.db, then answers a real question: NL → buckle (model=sql,
// riding the pinned `sql` upstream group) → ro-SQL over the sink DB →
// answer. Run: bun bench/w1219/e2e.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { buildReplica } from "./replica.ts";
import { buildPrompt } from "./prompt.ts";
import { extractSql, lintSql, execSql, rowsMatch } from "./kit.ts";
import { QUESTIONS } from "./questions.ts";
import { mintLaneKey, revokeLaneKey } from "../../hooks/lib/lane-auth.ts";

const PORT = 7819;
// The e2e must ride a buckle that BOOTED with the pinned conf — the live
// spoke may predate the pin (lanes hold no lifecycle authority to restart
// it). Scratch instance on :7821: scratch ledger/secrets/observations, the
// REAL machine conf verbatim (BUCKLE_UPSTREAMS), so the `sql` group rides
// exactly what production will load at its next boot.
const FRONT = "http://127.0.0.1:7919";
const ROOT_KEY = `bksk-${crypto.randomUUID().replaceAll("-", "")}`;
const UPSTREAMS = `${process.env.HOME}/.claude/local-llm/upstreams.json`;

/** Scratch buckle on :7919 over the REAL machine conf. */
function spawnBuckle(root: string) {
	return spawn(
		process.execPath,
		[join(import.meta.dir, "../../../buckle/src/server.ts")],
		{
			env: {
				...process.env,
				BUCKLE_PORT: "7919",
				BUCKLE_UPSTREAMS: UPSTREAMS,
				BUCKLE_DB: join(root, "buckle.db"),
				BUCKLE_ROOT_KEY: ROOT_KEY,
				BUCKLE_SECRETS_HOME: root,
				BUCKLE_OBSERVATIONS_PATH: join(root, "obs"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}

/** Boot the REAL sink face (knowledge-api.ts) over the replica. */
function spawnSink(root: string) {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dir, "../../hooks/bin/knowledge-api.ts"),
			"--port",
			String(PORT),
		],
		{
			env: { ...process.env, HOME: root, KNOWLEDGE_API_BIND: "127.0.0.1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return child;
}

const waitHealth = async (): Promise<boolean> => {
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (r.ok) return true;
		} catch {
			await Bun.sleep(200);
		}
	}
	return false;
};

/** This buckle vintage has no /health — ANY http response (401/404 count)
 *  proves the listener is up. */
const waitBuckle = async (): Promise<boolean> => {
	for (let i = 0; i < 60; i++) {
		try {
			await fetch(`${FRONT}/v1/models`, { signal: AbortSignal.timeout(1000) });
			return true;
		} catch {
			await Bun.sleep(250);
		}
	}
	return false;
};

if (import.meta.main) {
	const root = mkdtempSync(join(tmpdir(), "w1219-e2e-"));
	const rep = await buildReplica(root);
	const child = spawnSink(root);
	const buckle = spawnBuckle(root);
	const ok = await waitHealth();
	const buckOk = await waitBuckle();
	if (!ok || !buckOk) {
		console.error("sink face never went healthy");
		child.kill();
		buckle.kill();
		process.exit(1);
	}
	// the question rides the REAL sink DB (the file the face serves)
	const db = new Database(rep.dbPath, { readonly: true });
	// the scratch buckle's root key IS its admin — mint the e2e lane key there
	const minted = await mintLaneKey("w1219-sql-e2e", ROOT_KEY, undefined, FRONT);
	const q = QUESTIONS.find((x) => x.id === "Q02");
	if (!q) {
		console.error("Q02 missing");
		process.exit(1);
	}
	const prompt = buildPrompt(rep.schemaText, q.q);
	if (!minted) {
		console.error("lane key mint from the scratch buckle failed");
		child.kill();
		buckle.kill();
		process.exit(1);
	}
	const t0 = performance.now();
	const r = await fetch(`${FRONT}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${minted.key}`,
		},
		body: JSON.stringify({
			model: "sql",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 2048,
			temperature: 0,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	const d = (await r.json().catch(() => null)) as {
		model?: string;
		choices?: { message?: { content?: string }[] }[];
	} | null;
	// the pin contract: the scratch buckle must ride the sql group's wire id
	const rodePin = typeof d?.model === "string" && d.model.includes("Qwen3-4B");
	const sql = extractSql(d?.choices?.[0]?.message?.content ?? "");
	const lint = lintSql(sql);
	const res = lint.ok
		? execSql(db, sql)
		: { ok: false as const, error: lint.why ?? "lint" };
	const gold = execSql(db, q.gold_sql);
	const match = res.ok && gold.ok ? rowsMatch(res.rows, gold.rows) : false;
	const ms = Math.round(performance.now() - t0);
	console.log(
		JSON.stringify(
			{
				question: q.q,
				route: `${FRONT} model=sql (scratch buckle over the machine conf)`,
				http: r.status,
				ms,
				respModel: d?.model,
				rodePin,
				sql,
				valid: res.ok,
				match,
				rows: res.ok ? res.rows : undefined,
				goldRows: gold.ok ? gold.rows : undefined,
				error: res.ok ? undefined : (res.error ?? lint.why),
			},
			null,
			2,
		),
	);
	db.close();
	child.kill();
	buckle.kill();
	if (minted) await revokeLaneKey(minted.keyId, ROOT_KEY, undefined, FRONT);
	rep.close();
	process.exit(res.ok && match && rodePin ? 0 : 1);
}
