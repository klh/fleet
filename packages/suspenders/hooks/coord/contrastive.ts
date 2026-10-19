// hooks/coord/contrastive.ts — W927 consult-v2: the contrastive consult pool.
// Harness2 port (arXiv 2610.14224, selection.py): a consult fans to k
// candidate legs, collects their finals ANONYMIZED — labels A/B/… by a
// seeded shuffle keyed on the consult id — and a compose leg picks exactly
// ONE, writing <why> + an experience {cue, lesson, evidence, confidence}.
// IDENTITY-BLIND BY LAW: the compose prompt is assembled ONLY from
// {label, answer text} pairs — never a leg name, model id, or spend figure;
// the label→leg mapping lives on the consults row (`legs` JSON) for the
// report only. Pool rules (selection.py): exactly the k finals, no
// abstention by construction, one retry then inherit (STAGE_ATTEMPTS=2).
import {
	cyan,
	db,
	die,
	dim,
	green,
	kbNorm,
	projectIdentity,
} from "./shared.ts";
import { consultVersion, ensureConsultTrust } from "./consult-trust.ts";
import { consultDeadline } from "../lib/consult-expiry.ts";
import {
	cloudLeg,
	pinnedLeg,
	wireLeg,
	type LegResult,
} from "../lib/oracle-legs.ts";
import {
	assignIds,
	composePrompt,
	parseCompose,
	STAGE_ATTEMPTS,
	type ComposedPick,
} from "../lib/contrastive-selection.ts";

const LEG_MAX_TOKENS = 1500;
const LEG_TIMEOUT_MS = 300_000;

// the named candidate pool, in k-slice order: the :8903 default first, then
// the :8901 coder, the glm cloud leg, the :8906 danish/general specialist
export const POOL_ORDER = ["reason", "coder", "cloud", "danish"] as const;
export const DEFAULT_LEG = "reason";

export interface ContrastiveLeg {
	name: string;
	fire: (prompt: string) => Promise<LegResult>;
}

// config-over-code: defaults name the pinned fleet routes, env overrides
const specLeg = (name: "CODER" | "DANISH", defUrl: string): ContrastiveLeg => ({
	name: name.toLowerCase(),
	fire: (p) =>
		wireLeg(
			process.env[`ORACLE_${name}_URL`] ?? defUrl,
			process.env[`ORACLE_${name}_KEY`],
			p,
			LEG_MAX_TOKENS,
			LEG_TIMEOUT_MS,
		),
});

export const defaultPool = (): ContrastiveLeg[] => [
	{ name: "reason", fire: (p) => pinnedLeg(p, LEG_MAX_TOKENS, LEG_TIMEOUT_MS) },
	specLeg("CODER", "http://127.0.0.1:8901/v1/chat/completions"),
	{ name: "cloud", fire: (p) => cloudLeg(p, LEG_MAX_TOKENS) },
	specLeg("DANISH", "http://127.0.0.1:8906/v1/chat/completions"),
];

// pure selection (assignIds/composePrompt/parseCompose/STAGE_ATTEMPTS)
// lives in lib/contrastive-selection.ts — imported above (W927)

export async function fireStage(
	fire: (p: string) => Promise<LegResult>,
	prompt: string,
): Promise<LegResult | Error> {
	let err: unknown = null;
	for (let a = 0; a < STAGE_ATTEMPTS; a++) {
		try {
			return await fire(prompt);
		} catch (e) {
			err = e;
		}
	}
	return err instanceof Error ? err : new Error(String(err));
}

export interface PoolFinal {
	label: string;
	leg: string;
	text: string;
	model: string;
	ms: number;
	promptTok?: number;
	compTok?: number;
	inherited: boolean;
	error?: string;
}

export interface PoolOutcome {
	finals: PoolFinal[];
	refused: string | null;
}

// fire k legs in parallel, one retry each; a leg that exhausts both attempts
// inherits the default leg's final (exactly k finals, no abstention by
// construction) — dropped only when even the default has no final
export async function runPool(
	cid: number,
	legs: ContrastiveLeg[],
	question: string,
): Promise<PoolOutcome> {
	const settled = await Promise.all(
		legs.map(async (leg) => ({ leg, r: await fireStage(leg.fire, question) })),
	);
	const def = settled.find(
		(s) => s.leg.name === DEFAULT_LEG && !(s.r instanceof Error),
	);
	const finals: PoolFinal[] = [];
	let firstError: string | null = null;
	settled.forEach((s, i) => {
		const label = assignIds(cid, settled.length)[i] ?? "?";
		if (s.r instanceof Error) {
			firstError = firstError ?? s.r.message;
			if (def)
				finals.push({
					label,
					leg: s.leg.name,
					text: (def.r as LegResult).text,
					model: (def.r as LegResult).model,
					ms: 0,
					inherited: true,
					error: s.r.message,
				});
			return;
		}
		const r = s.r as LegResult;
		finals.push({
			label,
			leg: s.leg.name,
			text: r.text,
			model: r.model,
			ms: r.ms,
			promptTok: r.promptTok,
			compTok: r.compTok,
			inherited: false,
		});
	});
	return { finals, refused: finals.length ? null : firstError };
}

// ---- answer storage (shared with consult-reply's harvest) --------------------

export interface CandidateInput {
	question: string;
	answer: string;
	consultId: number | null;
	scope: string | null;
	answeredBy: string;
	askedBy: string;
	cue?: string | null;
	lesson?: string | null;
	evidence?: string | null;
	confidence?: string | null;
	domain?: string | null;
	version?: string | null;
}

// store the answer as a kb candidate (W618 dedup: same normalized question
// refines the row instead of forking; asker feedback `resolved` is what
// makes it reusable — verified-only law W142 holds for plane answers too)
export function storeCandidate(input: CandidateInput): number {
	const nq = kbNorm(input.question);
	const na = kbNorm(input.answer);
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
				: `${dup.solution}\n— ${input.answer.trim()}`;
		db.transaction(() => {
			db.query(
				"UPDATE consult_kb SET solution = ?, hits = hits + 1, last_hit_at = ?, cue = COALESCE(?, cue), lesson = COALESCE(?, lesson), evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence), domain = COALESCE(?, domain) WHERE id = ?",
			).run(
				refined,
				Date.now(),
				input.cue ?? null,
				input.lesson ?? null,
				input.evidence ?? null,
				input.confidence ?? null,
				input.domain ?? null,
				dup.id,
			);
			ensureConsultTrust(db);
			db.query(
				"INSERT OR IGNORE INTO consult_reuse (consult_id, kb_id) VALUES (?, ?)",
			).run(input.consultId ?? 0, dup.id);
		})();
		return dup.id;
	}
	const kr = db
		.query(
			"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at, cue, lesson, evidence, confidence, domain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			input.question,
			input.answer,
			projectIdentity(),
			input.askedBy,
			input.answeredBy,
			input.consultId,
			Date.now(),
			input.cue ?? null,
			input.lesson ?? null,
			input.evidence ?? null,
			input.confidence ?? null,
			input.domain ?? null,
		);
	const kbId = Number(kr.lastInsertRowid);
	db.transaction(() => {
		ensureConsultTrust(db);
		db.query(
			"INSERT INTO consult_trust (kb_id, scope, version) VALUES (?, ?, ?)",
		).run(kbId, input.scope ?? "", input.version ?? consultVersion() ?? "");
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kbId,
			input.question,
		);
	})();
	return kbId;
}

// ---- the orchestration --------------------------------------------------------

export interface ContrastiveInput {
	question: string;
	scope: string | null;
	as: string;
	domain: string | null;
	link: object;
	version?: string | null;
	k?: number;
	pool?: ContrastiveLeg[];
}

export interface ContrastiveOutcome {
	cid: number;
	pick: string | null;
	winner: string | null;
	confidence: string;
	answer: string;
	k: number;
	refused: string | null;
}

export async function runContrastive(
	input: ContrastiveInput,
): Promise<ContrastiveOutcome> {
	// mint the consult row first — the seeded labels key on the consult id
	const k = Math.min(
		Math.max(Math.trunc(Number(input.k) || 2), 2),
		POOL_ORDER.length,
	);
	const row = db
		.query(
			"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at, deadline_at, domain) VALUES (?, ?, 'contrastive', ?, ?, 'OPEN', ?, ?, ?)",
		)
		.run(
			projectIdentity(),
			input.as,
			input.question,
			input.scope,
			Date.now(),
			consultDeadline(Date.now()),
			input.domain,
		);
	const cid = Number(row.lastInsertRowid);
	const outcome = await runPool(
		cid,
		(input.pool ?? defaultPool()).slice(0, k),
		input.question,
	);
	if (!outcome.finals.length) {
		const reason = outcome.refused ?? "all candidate legs failed";
		db.query(
			"UPDATE consults SET state = 'REFUSED', answered_at = ? WHERE id = ?",
		).run(Date.now(), cid);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', NULL, ?, ?)",
		).run(
			Date.now(),
			input.as,
			JSON.stringify({
				consult: `C${cid}`,
				state: "REFUSED",
				reason,
				...input.link,
			}),
			input.as,
		);
		return {
			cid,
			pick: null,
			winner: null,
			confidence: "low",
			answer: "",
			k: 0,
			refused: reason,
		};
	}
	const labels = outcome.finals.map((f) => f.label);
	// compose stage — the pinned :8903 default leg; identity-blind prompt
	const composed = await fireStage(
		(p) => pinnedLeg(p, LEG_MAX_TOKENS, LEG_TIMEOUT_MS),
		composePrompt(input.question, outcome.finals),
	);
	let pick: ComposedPick | null =
		composed instanceof Error
			? null
			: parseCompose(composed.text, labels);
	const composeMeta =
		composed instanceof Error
			? { model: "", ms: 0, error: composed.message }
			: {
					model: composed.model,
					ms: composed.ms,
					promptTok: composed.promptTok,
					compTok: composed.compTok,
				};
	// one retry already spent inside fireStage — now inherit (pool rule):
	// the default leg's label wins, no compose opinion, low confidence
	if (!pick) {
		const defFinal =
			outcome.finals.find((f) => f.leg === DEFAULT_LEG) ?? outcome.finals[0];
		const win = defFinal ?? outcome.finals[0];
		if (!win)
			die("contrastive: no surviving final to inherit");
		const lesson =
			win.text.split("\n").find((l) => l.trim() !== "") ?? "";
		pick = {
			pick: win.label,
			why: "compose leg failed twice — pool-rule inheritance (STAGE_ATTEMPTS=2)",
			cue: "",
			lesson,
			evidence: `consult:C${cid}`,
			confidence: "low",
		};
		(composeMeta as { inherited?: boolean }).inherited = true;
	}
	const win =
		outcome.finals.find((f) => f.label === pick?.pick) ?? outcome.finals[0];
	if (!win)
		die("contrastive: pick resolved to no final");
	const answer = [
		win.text,
		`Why: ${pick?.why ?? ""}`,
		pick?.cue ? `Cue: ${pick.cue}` : null,
		`Lesson: ${pick?.lesson ?? ""}`,
		`Evidence: ${pick?.evidence ?? ""}`,
		`Confidence: ${pick?.confidence ?? "low"}`,
	]
		.filter((l) => l !== null)
		.join("\n");
	const mapping = {
		labels: Object.fromEntries(
			outcome.finals.map((f) => [f.label, f.leg]),
		),
		pick: pick?.pick ?? null,
		winner: win.leg,
		compose: composeMeta,
		legs: outcome.finals.map((f) => ({
			leg: f.leg,
			model: f.model,
			ms: f.ms,
			inherited: f.inherited,
			...(f.error ? { error: f.error } : {}),
		})),
	};
	db.query(
		"UPDATE consults SET state = 'ANSWERED', answer = ?, answered_at = ?, legs = ? WHERE id = ?",
	).run(answer, Date.now(), JSON.stringify(mapping), cid);
	const kbId = storeCandidate({
		question: input.question,
		answer,
		consultId: cid,
		scope: input.scope,
		answeredBy: "contrastive",
		askedBy: input.as,
		version: input.version ?? null,
		cue: pick?.cue ?? null,
		lesson: pick?.lesson ?? null,
		evidence: pick?.evidence ?? null,
		confidence: pick?.confidence ?? null,
		domain: input.domain,
	});
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', NULL, ?, ?)",
	).run(
		Date.now(),
		input.as,
		JSON.stringify({
			consult: `C${cid}`,
			state: "ANSWERED",
			...input.link,
			answer,
			pick: pick?.pick ?? null,
			confidence: pick?.confidence ?? "low",
			...(input.domain ? { domain: input.domain } : {}),
			kb: { id: kbId },
		}),
		input.as,
	);
	console.log(
		`${green("✓")} ${cyan(`C${cid}`)} contrastive pick ${pick?.pick} ${dim(`(${outcome.finals.length} finals, confidence ${pick?.confidence ?? "low"})`)}`,
	);
	console.log(answer);
	return {
		pick: pick?.pick ?? null,
		winner: win.leg,
		confidence: pick?.confidence ?? "low",
		answer,
		k: outcome.finals.length,
		refused: null,
	};
}
