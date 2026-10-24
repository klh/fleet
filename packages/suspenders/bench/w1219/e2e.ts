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
import {
	adminKey,
	mintLaneKey,
	revokeLaneKey,
	BUCKLE_FRONT,
} from "../../hooks/lib/lane-auth.ts";

const PORT = 7819;

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

if (import.meta.main) {
	const root = mkdtempSync(join(tmpdir(), "w1219-e2e-"));
	const rep = await buildReplica(root);
	const child = spawnSink(root);
	const ok = await waitHealth();
	if (!ok) {
		console.error("sink face never went healthy");
		child.kill();
		process.exit(1);
	}
	// the question rides the REAL sink DB (the file the face serves)
	const db = new Database(rep.dbPath, { readonly: true });
	const admin = adminKey();
	const minted = admin ? await mintLaneKey("w1219-sql-e2e", admin) : null;
	const q = QUESTIONS.find((x) => x.id === "Q02");
	if (!q) {
		console.error("Q02 missing");
		process.exit(1);
	}
	void child;
	const prompt = buildPrompt(rep.schemaText, q.q);
	const t0 = performance.now();
	const r = await fetch(`${BUCKLE_FRONT}/v1/chat/completions`, {
		method: "POST",
		headers: minted
			? {
					"content-type": "application/json",
					authorization: `Bearer ${minted.key}`,
				}
			: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "sql",
			messages: [{ role: "user", content: prompt }],
			temperature: 0,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	const d = (await r.json().catch(() => null)) as {
		choices?: { message?: { content?: string } }[];
	} | null;
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
				route: `${BUCKLE_FRONT} model=sql`,
				http: r.status,
				ms,
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
	if (admin && minted) await revokeLaneKey(minted.keyId, admin);
	rep.close();
	process.exit(res.ok && match ? 0 : 1);
}
