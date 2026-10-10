// hooks/coord/consult.ts — cross-agent consults (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	die,
	arg,
	db,
	green,
	dim,
	cyan,
	red,
	kbLookup,
	kbNorm,
	factLookup,
	lessonLookup,
	rankExperts,
	projectIdentity,
} from "./shared.ts";

import { consultVersion, ensureConsultTrust } from "./consult-trust.ts";
import { consultDeadline } from "../lib/consult-expiry.ts";

export async function cmdConsult(rest: string[]): Promise<void> {
	// a question, not work: no claims, no ownership change, no lane state.
	// Fleet-internal transport (event bus); cross-session questions go via
	// native @session messaging with who-knows for discovery.
	const as = arg("--as");
	const scope = arg("--scope");
	// W449: skip-next only applies to VALUE options — boolean flags (--best,
	// --no-kb) used to swallow the following positional (the question), so
	// `consult --best "q"` died with a usage error.
	const valueOpts = new Set(["--as", "--scope", "--version"]);
	const boolOpts = new Set(["--best", "--no-kb"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (valueOpts.has(rest[i])) {
			i++;
			continue;
		}
		if (boolOpts.has(rest[i])) continue;
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	let expert: string | null = null;
	let question: string;
	if (rest.includes("--best")) {
		question = pos.join(" ");
	} else {
		expert = pos[0] ?? null;
		question = pos.slice(1).join(" ");
	}
	if (!as) die("consult requires --as <asker-sid>");
	if ((!expert && !rest.includes("--best")) || !question)
		die(
			'usage: consult [--best] "<question>" | consult <sid> <question> [--scope s] --as <asker>',
		);
	// Lessons are advisory context, not verified solutions.
	const lessonHit = rest.includes("--no-kb") ? null : lessonLookup(question);
	const version = arg("--version") ?? consultVersion();
	const kbHit = rest.includes("--no-kb")
		? null
		: kbLookup(question, projectIdentity(), scope, version, true);
	// W604: consult_kb first (asker-verified solutions), then the knowledge
	// store — a hash-verified fact answers with its trust attached; lanes only
	// pinged on miss. --no-kb escapes both.
	const factHit = (kbHit || rest.includes("--no-kb"))
		? null
		: await factLookup(question);
	if (!kbHit && !factHit) {
		if (rest.includes("--best"))
			expert =
				rankExperts(projectIdentity(), question, scope, as)[0]?.sid ?? null;
		if (!expert)
			die(
				"no ranked expert — nobody live has touched this; retain evidence and request a decision, do not broadcast or retry unchanged",
			);
		if (
			!db
				.query(
					"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'",
				)
				.get(expert, projectIdentity())
		)
			die(`${expert.slice(0, 8)} is not a live session in this project`);
	}
	if (kbHit) {
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, 'KB', ?, ?, ?)",
			)
			.run(
				projectIdentity(),
				as,
				kbHit.answered_by,
				question,
				scope,
				kbHit.solution,
				Date.now(),
				Date.now(),
			);
		const cid = `C${r.lastInsertRowid}`;
		ensureConsultTrust(db);
		db.query("INSERT INTO consult_reuse (consult_id, kb_id) VALUES (?, ?)").run(
			r.lastInsertRowid,
			kbHit.id,
		);
		const expertLive = !!db
			.query(
				"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'",
			)
			.get(kbHit.answered_by, projectIdentity());
		db.query(
			"UPDATE consult_kb SET hits = hits + 1, last_hit_at = ? WHERE id = ?",
		).run(Date.now(), kbHit.id);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)",
		).run(
			Date.now(),
			as,
			scope,
			JSON.stringify({
				consult: cid,
				state: "KB",
				answer: kbHit.solution,
				kb: {
					id: kbHit.id,
					solved_by: kbHit.answered_by,
					expert_live: expertLive,
				},
			}),
			as,
		);
		console.log(
			`${green("✓")} ${cyan(cid)} answered from the knowledge base ${dim(`(learned from ${kbHit.answered_by.slice(0, 8)}${expertLive ? ", still live" : ""}, ${kbHit.hits} prior hits) — --no-kb routes to a human`)}`,
		);
	} else if (factHit) {
		// W604: a hash-verified knowledge row answers BY THE PLANE with its
		// trust attached — the consult is never routed to a live lane.
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, 'FACT', ?, ?, ?)",
			)
			.run(
				projectIdentity(),
				as,
				factHit.origin_sid ?? "",
				question,
				scope,
				factHit.fact ?? "",
				Date.now(),
				Date.now(),
			);
		const cid = `C${r.lastInsertRowid}`;
		const payload = JSON.stringify({
			consult: cid,
			state: "FACT",
			answer: factHit.fact ?? "",
			fact: { id: factHit.id, topic: factHit.topic, trust: factHit.trust, source: factHit.source_ref },
		});
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)",
		).run(Date.now(), as, scope, payload, as);
		console.log(
			`${green("✓")} ${cyan(cid)} answered from a verified fleet fact ${dim(`k#${factHit.id} "${factHit.topic}" [hash ${factHit.trust}] — --no-kb routes to a human`)}`,
		);
	} else {
		const pending = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM consults WHERE project = ? AND expert_sid = ? AND state = 'OPEN' AND created_at > ?",
				)
				.get(projectIdentity(), expert, Date.now() - 3_600_000) as { n: number }
		).n;
		if (pending >= 3)
			die(
				"expert consult queue is full; retain evidence and choose another relevant expert",
			);
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at, deadline_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)",
			)
			.run(
				projectIdentity(),
				as,
				expert,
				question,
				scope,
				Date.now(),
				consultDeadline(Date.now()),
			);
		const cid = `C${r.lastInsertRowid}`;
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', ?, ?, ?)",
		).run(
			Date.now(),
			as,
			scope,
			JSON.stringify({
				consult: cid,
				q: question,
				guidance: lessonHit
					? { key: lessonHit.key, value: lessonHit.value, verified: false }
					: null,
			}),
			expert,
		);
		console.log(`CONSULT ${cyan(cid)} ${dim("→")} ${expert?.slice(0, 8)}`);
	}
}

export async function cmdConsultReply(rest: string[]): Promise<void> {
	const as = arg("--as");
	const known = new Set(["--as", "--evidence", "--version", "--feedback"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i] === "--decline") continue;
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const decline = rest.includes("--decline");
	const cid = pos[0];
	const text = pos.slice(1).join(" ");
	if (!cid || (!text && !decline && !arg("--feedback")) || !as)
		die(
			'usage: consult-reply <C##> "<answer>" [--decline] [--version ref] --as <expert-sid> | consult-reply <C##> --feedback resolved|failed|unused [--evidence result] [--version ref] --as <asker-sid>',
		);
	const c = db
		.query("SELECT * FROM consults WHERE id = ? AND project = ?")
		.get(Number(String(cid).replace(/^C/i, "")), projectIdentity()) as
		| {
				id: number;
				asker_sid: string;
				expert_sid: string;
				state: string;
				question: string;
				scope: string | null;
		  }
		| undefined;
	if (!c) die(`no such consult: ${cid}`);
	const feedback = arg("--feedback");
	if (feedback) {
		if (c.asker_sid !== as) die("only the asker can record a consult outcome");
		if (!["ANSWERED", "KB"].includes(c.state))
			die(`${cid} is ${c.state}; no candidate to verify`);
		if (!["resolved", "failed", "unused"].includes(feedback))
			die("feedback must be resolved, failed or unused");
		const evidence = arg("--evidence")?.trim() ?? "";
		if (feedback !== "unused" && !evidence)
			die(
				"resolved/failed feedback requires --evidence with the observed result",
			);
		ensureConsultTrust(db);
		const kb = db
			.query(
				"SELECT id FROM consult_kb WHERE consult_id = ? UNION SELECT kb_id AS id FROM consult_reuse WHERE consult_id = ? LIMIT 1",
			)
			.get(c.id, c.id) as { id: number } | undefined;
		if (!kb) die("no stored candidate for this consult");
		if (feedback === "resolved") {
			const trust = db
				.query("SELECT version, scope FROM consult_trust WHERE kb_id = ?")
				.get(kb.id) as { version: string; scope: string } | undefined;
			const version = arg("--version") ?? consultVersion();
			if (!trust?.scope || !version || trust.version !== version)
				die(
					"candidate code version changed or scope unknown; ask again with an explicit scope",
				);
		}
		db.transaction(() => {
			const previous = db
				.query("SELECT outcome FROM consult_feedback WHERE consult_id = ?")
				.get(c.id) as { outcome: string } | undefined;
			if (previous) die("feedback already recorded for this consult");
			db.query("INSERT INTO consult_feedback VALUES (?, ?, ?, ?, ?)").run(
				c.id,
				feedback,
				evidence,
				as,
				Date.now(),
			);
			if (feedback === "resolved")
				db.query(
					"UPDATE consult_trust SET evidence = ?, verified_by = ?, verified_at = ?, resolved = resolved + 1 WHERE kb_id = ?",
				).run(evidence, as, Date.now(), kb.id);
			if (feedback === "failed")
				db.query(
					"UPDATE consult_trust SET failed = failed + 1, verified_at = NULL WHERE kb_id = ?",
				).run(kb.id);
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.feedback', ?, ?, ?)",
			).run(
				Date.now(),
				as,
				c.scope,
				JSON.stringify({ consult: cid, outcome: feedback, evidence }),
				c.expert_sid,
			);
		})();
		console.log(`FEEDBACK ${cid} ${feedback}`);
		return;
	}
	if (c.expert_sid !== as)
		die(`${cid} is addressed to ${String(c.expert_sid).slice(0, 8)}, not you`);
	if (c.state !== "OPEN") die(`${cid} is ${c.state}`);
	const st = decline ? "DECLINED" : "ANSWERED";
	db.query(
		"UPDATE consults SET state = ?, answer = ?, answered_at = ? WHERE id = ?",
	).run(st, decline ? null : text, Date.now(), c.id);
	// Store candidates, but only asker-verified outcomes permit automatic reuse.
	// W618 dedup: a same-project row with the same normalized problem+answer
	// fingerprint absorbs the reply — hits/last_hit_at bump, a differing answer
	// appends as a refinement — instead of forking a near-duplicate row.
	if (!decline) {
		const nq = kbNorm(c.question);
		const na = kbNorm(text);
		const dup = (
			db
				.query(
					"SELECT id, problem, solution FROM consult_kb WHERE project = ? ORDER BY id",
				)
				.all(projectIdentity()) as {
				id: number;
				problem: string;
				solution: string;
			}[]
		).find((k) => kbNorm(k.problem) === nq);
		if (dup) {
			const refined =
				kbNorm(dup.solution) === na
					? dup.solution
					: `${dup.solution}\n— ${text.trim()}`;
			db.transaction(() => {
				db.query(
					"UPDATE consult_kb SET solution = ?, hits = hits + 1, last_hit_at = ? WHERE id = ?",
				).run(refined, Date.now(), dup.id);
				ensureConsultTrust(db);
				// link this consult to the row it replenished, so asker feedback
				// resolves the candidate (the row keeps its original consult_id)
				db.query(
					"INSERT OR IGNORE INTO consult_reuse (consult_id, kb_id) VALUES (?, ?)",
				).run(c.id, dup.id);
			})();
		} else {
			const kr = db
				.query(
					"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					c.question,
					text,
					projectIdentity(),
					c.asker_sid,
					as,
					c.id,
					Date.now(),
				);
			ensureConsultTrust(db);
			db.query(
				"INSERT INTO consult_trust (kb_id, scope, version) VALUES (?, ?, ?)",
			).run(
				kr.lastInsertRowid,
				c.scope ?? "",
				arg("--version") ?? consultVersion() ?? "",
			);
			db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
				kr.lastInsertRowid,
				c.question,
			);
		}
	}
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', NULL, ?, ?)",
	).run(
		Date.now(),
		as,
		JSON.stringify({ consult: cid, state: st, answer: decline ? null : text }),
		c.asker_sid,
	);
	console.log(
		`${st} ${cyan(String(cid))} ${dim("→")} ${String(c.asker_sid).slice(0, 8)}`,
	);
}

export async function cmdConsults(_rest: string[]): Promise<void> {
	// my consult queue: OPEN questions addressed to me + my recent threads
	const as = arg("--as");
	if (!as) die("usage: consults --as <sid>");
	const rows = db
		.query(
			"SELECT id, asker_sid, question, state, answer FROM consults WHERE project = ? AND (expert_sid = ? OR asker_sid = ?) ORDER BY id DESC LIMIT 20",
		)
		.all(projectIdentity(), as, as) as {
		id: number;
		asker_sid: string;
		question: string;
		state: string;
		answer: string | null;
	}[];
	console.log(
		rows
			.map((r) => {
				const cid = `C${r.id}`;
				if (r.state === "OPEN")
					return `${red("?")} ${cyan(cid)} ← ${dim(`from ${String(r.asker_sid).slice(0, 8)}`)} ${r.question.slice(0, 60)}`;
				return `${green("✓")} ${cyan(cid)} → ${dim(`asked ${String(r.asker_sid).slice(0, 8)}`)} ${String(r.answer ?? "").slice(0, 60)}`;
			})
			.join("\n") || dim("(no consults)"),
	);
}

export async function cmdWhoKnows(rest: string[]): Promise<void> {
	// contextual expertise: who recently TOUCHED this beats nominal strength
	const scope = arg("--scope");
	const known = new Set(["--scope"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const q = pos.join(" ");
	if (!q && !scope) die('usage: who-knows "query words" [--scope src/x]');
	const rows = rankExperts(projectIdentity(), q, scope).slice(0, 5);
	console.log(
		rows
			.map((r) => `${r.sid.slice(0, 8)}  ${r.score.toFixed(2)}  ${dim(r.hint)}`)
			.join("\n") || dim("(no ranked session — nobody live has touched this)"),
	);
}
