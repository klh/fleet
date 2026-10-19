// hooks/lib/consult-federation-hub.ts — the consult hub edge (W934.2.1.2).
// Split from consult-federation.ts so the CLI wiring file stays small and
// each module owns one concern: this one owns the OUTBOUND hub leg (resolve,
// bounded POST /v1/consult, singleflight join, negative cache) and the
// stale-feedback loop (failed feedback revokes cited knowledge rows until
// re-verified). Contract: docs/design/consult-federation.md (W934.1).

import {
	type Citation,
	type ConsultEnvelope,
	citationsFor,
	ensureConsultFederation,
	type HubAnswer,
	type HubPolicy,
	recordCitations,
} from "./consult-federation.ts";

export type { HubAnswer };

import { openKnowledgeDb } from "./govdb.ts";
import { type HubLocation, resolveHub } from "./hub-locate.ts";

export function miss(
	why: string,
	hub: string | null,
	via: string | null,
): HubAnswer {
	return {
		ok: false,
		state: "DEGRADED",
		answer: null,
		citations: [],
		hub,
		via,
		why,
	};
}

// Hub citations ride the wire as snake_case JSON; ref_id coerces to a number
// (0 when the hub cites non-numeric ids), strings cap at 300 chars and the
// list at 8 entries so a hub answer can only cite a bounded set.
export function sanitizeCitations(raw: unknown): Citation[] {
	if (!Array.isArray(raw)) return [];
	const out: Citation[] = [];
	for (const r of raw.slice(0, 8)) {
		const o = r as Record<string, unknown>;
		const refId = Number(o.ref_id);
		const src =
			typeof o.source_ref === "string" ? o.source_ref.slice(0, 300) : null;
		if (!Number.isFinite(refId) && src === null) continue;
		out.push({
			kind: "hub",
			refId: Number.isFinite(refId) ? refId : 0,
			sourceRef: src,
			sourceHash:
				typeof o.source_hash === "string" ? o.source_hash.slice(0, 128) : null,
		});
	}
	return out;
}

export function hubHeaders(loc: HubLocation): Record<string, string> {
	return {
		"content-type": "application/json",
		...(loc.token ? { authorization: `Bearer ${loc.token}` } : {}),
	};
}

export function hubRequestBody(env: ConsultEnvelope, question: string): string {
	return JSON.stringify({
		consult_id: env.consultId,
		trace_id: env.traceId,
		idempotency_key: env.idempotencyKey,
		caller: env.origin,
		project: env.project,
		scope: env.scope,
		question,
		max_hops: env.maxHops,
		visited_hubs: env.visitedHubs,
	});
}

// One bounded POST to the entitled hub's consult edge: the deadline bounds
// the whole leg; one jittered retry, then honest DEGRADED (never a guess).
export async function consultViaHub(
	env: ConsultEnvelope,
	question: string,
	policy: HubPolicy,
): Promise<HubAnswer> {
	const loc = await resolveHub(policy.hub ?? "local");
	if (!loc) return miss(`hub unresolved or down`, policy.hub ?? "local", null);
	const deadline = AbortSignal.timeout(policy.deadlineMs ?? 20_000);
	let lastErr = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0 && deadline.aborted) break;
		if (attempt > 0)
			await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
		try {
			const res = await fetch(`${loc.url}/v1/consult`, {
				method: "POST",
				headers: hubHeaders(loc),
				body: hubRequestBody(env, question),
				signal: deadline,
			});
			const handled = await hubResponse(res, loc);
			if (handled) return handled;
			lastErr = `HTTP ${res.status}`;
		} catch (err) {
			lastErr = String(err).slice(0, 200);
		}
	}
	return miss(`hub consult failed: ${lastErr}`, loc.label, loc.via);
}

// hubResponse — classify the wire response; null = caller degrades.
export async function hubResponse(
	res: Response,
	loc: HubLocation,
): Promise<HubAnswer | null> {
	if (res.status === 200) {
		const body = (await res.json()) as Record<string, unknown>;
		const answer =
			typeof body.answer === "string" ? body.answer.slice(0, 4000) : null;
		if (answer === null)
			return miss("hub 200 without an answer", loc.label, loc.via);
		return {
			ok: true,
			state: "ANSWERED",
			answer,
			citations: sanitizeCitations(body.citations),
			hub: loc.label,
			via: loc.via,
			why: null,
		};
	}
	if (res.status === 202)
		return {
			ok: false,
			state: "PENDING",
			answer: null,
			citations: [],
			hub: loc.label,
			via: loc.via,
			why: "hub accepted, answer pending",
		};
	return null;
}

// ─── singleflight + negative cache ───
// Singleflight: a fresh PENDING row with the same idempotency key is JOINED
// instead of re-asked. Negative cache: a recent DEGRADED/UNANSWERED attempt
// on the key suppresses the hub leg for cooldownMs (herd control).
export function joinPendingHubConsult(
	db: GovernorStore,
	key: string,
	withinMs: number,
): number | null {
	ensureConsultFederation(db);
	const row = db
		.query(
			"SELECT consult_id FROM consult_federation WHERE idempotency_key = ? AND state = 'PENDING' AND created_at > ? LIMIT 1",
		)
		.get(key, Date.now() - withinMs) as { consult_id: number } | undefined;
	return row?.consult_id ?? null;
}

export function hubCooldownActive(db: GovernorStore, key: string): boolean {
	ensureConsultFederation(db);
	const row = db
		.query(
			"SELECT 1 FROM consult_hub_cache WHERE key = ? AND until > ? LIMIT 1",
		)
		.get(key, Date.now());
	return row !== null && row !== undefined;
}

export function setHubCooldown(
	db: GovernorStore,
	key: string,
	outcome: string,
	hub: string | null,
	cooldownMs: number,
): void {
	ensureConsultFederation(db);
	db.query(
		"INSERT OR REPLACE INTO consult_hub_cache (key, outcome, hub, until) VALUES (?, ?, ?, ?)",
	).run(key, outcome.slice(0, 200), hub, Date.now() + cooldownMs);
}

// ─── stale feedback ───
// A failed FACT-answered consult demotes its cited knowledge rows: the
// demotion is DERIVED (citations joined to failed feedback), needs no new
// column, and stays consistent if feedback is later audited. The event trail
// carries the consult link; recovery is an operator action.
export function applyStaleFeedback(
	db: GovernorStore,
	consultId: number,
): { demoted: number[] } {
	ensureConsultFederation(db);
	const cites = citationsFor(db, consultId).filter((c) => c.kind === "fact");
	const demoted: number[] = [];
	for (const c of cites) {
		const row = openKnowledgeDb()
			.query("SELECT state FROM knowledge WHERE id = ?")
			.get(c.refId) as { state: string } | undefined;
		if (!row || ["retired", "graveyard"].includes(row.state)) continue;
		demoted.push(c.refId);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.stale', NULL, ?, '')",
		).run(
			Date.now(),
			"consult-federation",
			JSON.stringify({
				consult: `C${consultId}`,
				fact: c.refId,
				state: "stale",
			}),
		);
	}
	return { demoted };
}

// factDemoted — the read-side predicate: a fact with a failed cited consult
// no longer auto-answers (factLookup consults this before scoring).
export function factDemoted(db: GovernorStore, factId: number): boolean {
	ensureConsultFederation(db);
	try {
		return !!db
			.query(
				"SELECT 1 FROM consult_citations c JOIN consult_feedback f ON f.consult_id = c.consult_id WHERE c.kind = 'fact' AND c.ref_id = ? AND f.outcome = 'failed' LIMIT 1",
			)
			.get(factId);
	} catch {
		return false;
	}
}

// attemptHubLeg — the consult CLI's outbound hub leg: mint the consults row
// (expert_sid ''), run the bounded hub POST, and write the verdict. Returns
// handled when the consult ENDED here (answered/pending/joined); the caller
// falls through to its refused path on anything else.
export async function attemptHubLeg(
	db: GovernorStore,
	env: ConsultEnvelope,
	question: string,
	policy: HubPolicy,
	link: Record<string, unknown>,
): Promise<{
	handled: boolean;
	why: string | null;
	hub: string | null;
	cid: number | null;
	answer: string | null;
}> {
	const cid = insertHubConsultRow(db, env, question);
	if (cid === null)
		return {
			handled: false,
			why: "hub row insert failed",
			hub: null,
			cid: null,
			answer: null,
		};
	const answer = await consultViaHub(env, question, policy);
	if (answer.state === "ANSWERED") {
		db.query(
			"UPDATE consults SET answer = ?, answered_at = ? WHERE id = ?",
		).run(answer.answer, Date.now(), cid);
		recordCitations(db, cid, answer.citations);
		const ev = {
			consult: `C${cid}`,
			state: "HUB",
			...link,
			answer: answer.answer,
			hub: { label: answer.hub, trace_id: env.traceId },
		};
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)",
		).run(Date.now(), env.origin, env.scope, JSON.stringify(ev), env.origin);
		return {
			handled: true,
			why: null,
			hub: answer.hub,
			cid,
			answer: answer.answer,
		};
	}
	if (answer.state === "PENDING") {
		db.query(
			"UPDATE consult_federation SET state = 'PENDING' WHERE consult_id = ?",
		).run(cid);
		return {
			handled: true,
			why: "hub accepted, answer pending",
			hub: answer.hub,
			cid,
			answer: null,
		};
	}
	db.query("UPDATE consults SET state = 'HUB_MISS' WHERE id = ?").run(cid);
	db.query(
		"UPDATE consult_federation SET state = 'HUB_MISS' WHERE consult_id = ?",
	).run(cid);
	setHubCooldown(
		db,
		env.idempotencyKey,
		answer.why ?? "degraded",
		answer.hub,
		policy.cooldownMs ?? 300_000,
	);
	return {
		handled: false,
		why: answer.why,
		hub: answer.hub,
		cid,
		answer: null,
	};
}

// insertHubConsultRow — mints the consults row (state HUB, no local expert)
// plus its consult_federation envelope row; returns the numeric consult id.
export function insertHubConsultRow(
	db: GovernorStore,
	env: ConsultEnvelope,
	question: string,
): number | null {
	try {
		const hr = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'HUB', ?)",
			)
			.run(env.project, env.origin, "", question, env.scope, Date.now());
		const cid = Number(hr.lastInsertRowid);
		db.query(
			"INSERT INTO consult_federation (consult_id, trace_id, idempotency_key, route, hub, state, created_at) VALUES (?, ?, ?, ?, ?, 'HUB', ?)",
		).run(
			cid,
			env.traceId,
			env.idempotencyKey,
			JSON.stringify([{ stage: "hub", at: Date.now() }]),
			env.visitedHubs.length > 0 ? env.visitedHubs.join(",") : null,
			Date.now(),
		);
		return cid;
	} catch {
		return null;
	}
}
