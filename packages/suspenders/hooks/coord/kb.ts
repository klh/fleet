// hooks/coord/kb.ts — W2569: the kb verb (stats/search/list) in its own
// module, carved out of facts.ts at its 1200-line stop-rule decomposition.
// Both faces render FROM the kbContract JSON core (machine-readable --json).

import { z } from "zod";
import { makeStamp } from "../lib/knowledge/confidence.ts";
import { ensureConsultTrust } from "./consult-trust.ts";
import { verbContract, wantsJson } from "./json-out.ts";
import { cyan, db, die, dim, kbLookup, projectIdentity } from "./shared.ts";

// W2569: the kb machine contract — stats/search/list share one envelope.
const kbRowShape = z.object({
	id: z.number().int(),
	problem: z.string(),
	solution: z.string(),
	answeredBy: z.string(),
	hits: z.number().int(),
});
const kbContract = verbContract({
	sub: z.enum(["stats", "search", "list"]),
	project: z.string(),
	solutions: z.number().int().nullable(),
	hits: z.number().int().nullable(),
	consults: z
		.object({
			open: z.number().int(),
			human: z.number().int(),
			kb: z.number().int(),
			declined: z.number().int(),
			refused: z.number().int(),
			contrastive: z.number().int(),
		})
		.nullable(),
	outcomes: z
		.object({
			resolved: z.number().int(),
			failed: z.number().int(),
			unused: z.number().int(),
		})
		.nullable(),
	medianMs: z.number().nullable(),
	match: kbRowShape.nullable(),
	rows: z.array(kbRowShape).nullable(),
});

export async function cmdKb(rest: string[]): Promise<void> {
	// the fleet's shared memory: what consults have already answered
	const sub = rest[0];
	if (sub === "add") {
		// direct seed: distill a mistake/lesson without a consult round-trip
		// (owner 2026-09-28: harvest worker logs -> kb so mistakes don't repeat)
		const sep = rest.indexOf("--solution");
		const problem = rest.slice(1, sep === -1 ? rest.length : sep).join(" ");
		const solution =
			sep === -1
				? ""
				: rest
						.slice(sep + 1)
						.filter((a) => a !== "--as")
						.join(" ");
		const as = (() => {
			const i = rest.indexOf("--as");
			return i >= 0 ? rest[i + 1] : null;
		})();
		if (!problem || !solution)
			die('usage: kb add "<problem>" --solution "<solution>" [--as <sid>]');
		const kr = db
			.query(
				"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at, confidence, confidence_stamp) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
			)
			.run(
				problem,
				solution,
				projectIdentity(),
				as ?? "harvest",
				as ?? "harvest",
				Date.now(),
				as ? 0.6 : 0.4,
				JSON.stringify(
					makeStamp({
						value: as ? 0.6 : 0.4,
						setter: as ? `model:${as}` : "mechanical:harvest",
					}),
				),
			);
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kr.lastInsertRowid,
			problem,
		);
		console.log(`✓ kb#${kr.lastInsertRowid} seeded`);
		process.exit(0);
	}
	if (sub === "stats") {
		const project = projectIdentity();
		const json = wantsJson(rest);
		ensureConsultTrust(db);
		const tot = (
			db
				.query("SELECT COUNT(*) AS n FROM consult_kb WHERE project = ?")
				.get(project) as { n: number }
		).n;
		const hits = (
			db
				.query(
					"SELECT COALESCE(SUM(hits), 0) AS n FROM consult_kb WHERE project = ?",
				)
				.get(project) as {
				n: number;
			}
		).n;
		const byState = db
			.query(
				"SELECT state, COUNT(*) AS n FROM consults WHERE project = ? GROUP BY state",
			)
			.all(project) as { state: string; n: number }[];
		const lat = db
			.query(
				"SELECT answered_at - created_at AS ms FROM consults WHERE project = ? AND state = 'ANSWERED' AND answered_at IS NOT NULL ORDER BY ms",
			)
			.all(project) as { ms: number }[];
		const median = lat.length ? lat[Math.floor(lat.length / 2)].ms : 0;
		const s = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
		const contrastive = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM consults WHERE project = ? AND expert_sid = 'contrastive'",
				)
				.get(project) as { n: number }
		).n;
		const outcomes = db
			.query(
				"SELECT f.outcome, COUNT(*) AS n FROM consult_feedback f JOIN consults c ON c.id = f.consult_id WHERE c.project = ? GROUP BY f.outcome",
			)
			.all(project) as { outcome: string; n: number }[];
		const outcome = (name: string) =>
			outcomes.find((o) => o.outcome === name)?.n ?? 0;
		if (json) {
			// W2569: the machine face — same counts, one envelope
			kbContract.emit({
				schema_version: 1,
				verb: "kb",
				sub: "stats",
				project,
				solutions: tot,
				hits,
				consults: {
					open: s("OPEN"),
					human: s("ANSWERED"),
					kb: s("KB"),
					declined: s("DECLINED"),
					refused: s("REFUSED"),
					contrastive,
				},
				outcomes: {
					resolved: outcome("resolved"),
					failed: outcome("failed"),
					unused: outcome("unused"),
				},
				medianMs: median || null,
				match: null,
				rows: null,
			});
			return;
		}
		console.log(
			`kb: ${tot} solutions · ${hits} repeat questions auto-answered · consults: ${s("OPEN")} open, ${s("ANSWERED")} human, ${s("KB")} via kb, ${s("DECLINED")} declined, ${s("REFUSED")} refused, ${contrastive} contrastive`,
		);
		console.log(
			`outcomes: ${outcome("resolved")} resolved, ${outcome("failed")} failed, ${outcome("unused")} unused (verification, not message volume)`,
		);
		if (median && hits)
			console.log(
				dim(
					`median human answer ${Math.round(median / 60000)}min — est. ${Math.round((hits * median) / 60000)}min of round-trips skipped (hits × median)`,
				),
			);
	} else if (sub === "search") {
		const q = rest
			.slice(1)
			.filter((t) => !t.startsWith("--"))
			.join(" ");
		if (!q) die('usage: kb search "<query words>" | kb list | kb stats');
		const hit = kbLookup(q);
		if (wantsJson(rest)) {
			// W2569: the machine face — the match row or the honest miss
			kbContract.emit({
				schema_version: 1,
				verb: "kb",
				sub: "search",
				project: projectIdentity(),
				solutions: null,
				hits: null,
				consults: null,
				outcomes: null,
				medianMs: null,
				match: hit
					? {
							id: hit.id,
							problem: hit.problem,
							solution: hit.solution,
							answeredBy: String(hit.answered_by),
							hits: hit.hits,
						}
					: null,
				rows: null,
			});
			if (!hit) process.exitCode = 1;
		} else if (!hit) {
			console.log(dim("(no kb match)"));
			process.exitCode = 1;
		} else
			console.log(
				`${cyan(`kb#${hit.id}`)} ${dim(`learned from ${String(hit.answered_by).slice(0, 8)}, ${hit.hits} hits`)}\n  Q: ${hit.problem}\n  A: ${hit.solution}`,
			);
	} else if (sub === "list") {
		const rows = db
			.query(
				"SELECT id, problem, solution, answered_by, hits, created_at FROM consult_kb WHERE project = ? ORDER BY id DESC LIMIT 20",
			)
			.all(projectIdentity()) as {
			id: number;
			problem: string;
			solution: string;
			answered_by: string;
			hits: number;
		}[];
		if (wantsJson(rest)) {
			// W2569: the machine face — the same 20-row page, unparsed fields
			kbContract.emit({
				schema_version: 1,
				verb: "kb",
				sub: "list",
				project: projectIdentity(),
				solutions: null,
				hits: null,
				consults: null,
				outcomes: null,
				medianMs: null,
				match: null,
				rows: rows.map((r) => ({
					id: r.id,
					problem: r.problem,
					solution: r.solution,
					answeredBy: r.answered_by,
					hits: r.hits,
				})),
			});
			return;
		}
		console.log(
			rows
				.map(
					(r) =>
						`${cyan(`kb#${r.id}`)} ${dim(String(r.answered_by).slice(0, 8))} ${r.problem.slice(0, 50)} ${dim("→")} ${r.solution.slice(0, 50)}`,
				)
				.join("\n") || dim("(kb empty — answers land here via consult-reply)"),
		);
	} else die('usage: kb stats | kb list | kb search "<query words>"');
}
