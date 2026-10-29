// hooks/coord/consult-v2-cli.ts — hub design phase 4: the coord faces of
// consult v2. `coord ask` is the ONE verb (kind ask|tell|bank, route
// sid|sid,sid|fleet|hub:<name>, priority high|normal|low); `consult`,
// `consult-reply` and `knowledge-enqueue` stay as they were (aliases of the
// older shapes). `consult-defer` is the recipient's explicit ack; `consult-
// tick` runs one delivery pass (queued-interrupt flush + escalation) and is
// fired by the fleet-loop maintenance task `consult-tick`.
//
// Live wiring of the DeliveryDeps seam: oracle = factLookup (candidate +
// active tiers), steer = steerForConsult (kill switch, scrub, liveness — not
// the steer rate gate), emit = the events table + directed receipts, bank =
// the Kev store/noise/review gate (Kev rides buckle via kev-curation).
import { coordSettings } from "../lib/consult/consult-config.ts";
import {
	type DeliveryDeps,
	deferConsult,
	ensureConsultV2,
	settleFleetAnswer,
	submitConsult,
	tickConsults,
} from "../lib/consult/consult-delivery.ts";
import {
	type ConsultKind,
	parsePriority,
	parseRoute,
} from "../lib/consult/consult-v2.ts";
import {
	ensureConsultFederation,
	recordCitations,
} from "../lib/federation/consult-federation.ts";
import { suggestKnowledge } from "../lib/knowledge/kev-curation.ts";
import { curationGate, deferToReview } from "../lib/knowledge/kev-review.ts";
import { applyVote } from "../lib/knowledge/knowledge-votes.ts";
import {
	enqueueKnowledge,
	withKnowledgeDb,
} from "../lib/knowledge/sqlite-store.ts";
import { queueDirectedReceipt } from "./bus.ts";
import {
	arg,
	db,
	die,
	factLookup,
	lessonLookup,
	projectIdentity,
} from "./shared.ts";
import { steerForConsult } from "./steer.ts";

export function liveDeps(): DeliveryDeps {
	return {
		project: projectIdentity(),
		now: () => Date.now(),
		oracle: async (q) => {
			const h = await factLookup(q);
			return h ? { hit: h, tier: h.oracle } : null;
		},
		steer: (sid, text, source) => steerForConsult(sid, text, source),
		emit: (e) => {
			const id = Number(
				db
					.query(
						"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, NULL, ?, ?)",
					)
					.run(
						Date.now(),
						e.source,
						e.kind,
						JSON.stringify({ project: projectIdentity(), ...e.payload }),
						e.to ?? "",
					).lastInsertRowid,
			);
			if (e.to) queueDirectedReceipt(id, e.to);
			return id;
		},
		bank: async (title, text, ref) => {
			const v = await suggestKnowledge({
				kind: "consult",
				title,
				text,
				reference: ref,
			});
			const gate = curationGate(v.choice);
			if (gate === "store")
				await enqueueKnowledge({ source: `consult ${ref}`, payload: text });
			else if (gate === "defer")
				withKnowledgeDb((kb) =>
					deferToReview(kb, {
						kind: "consult",
						reference: ref,
						title,
						text,
						sid: "",
						project: projectIdentity(),
					}),
				);
			return gate;
		},
		lessons: (q) => {
			const l = lessonLookup(q);
			return l ? [`${l.key}: ${l.value.slice(0, 200)}`] : [];
		},
		cite: (consultId, hit) => {
			if (hit.id == null) return;
			ensureConsultFederation(db);
			recordCitations(db, consultId, [
				{
					kind: "fact",
					refId: hit.id,
					sourceRef: hit.source_ref ?? null,
					sourceHash: null,
				},
			]);
		},
	};
}

const ASK_USAGE =
	'usage: ask "<question>" --to <sid>|<sid,sid>|fleet|hub:<name> [--kind ask|tell|bank] [--priority high|normal|low] [--non-blocking] [--scope s] --as <sid>';

export async function cmdAsk(rest: string[]): Promise<void> {
	const values = new Set(["--to", "--kind", "--priority", "--scope", "--as"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (values.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i] === "--non-blocking") continue;
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}\n${ASK_USAGE}`);
		pos.push(rest[i]);
	}
	const as = arg("--as");
	const question = pos.join(" ").trim();
	const kind = (arg("--kind") ?? "ask") as ConsultKind;
	if (!as || !question) die(ASK_USAGE);
	if (!["ask", "tell", "bank"].includes(kind))
		die(`--kind must be ask|tell|bank\n${ASK_USAGE}`);
	const toRaw = arg("--to") ?? (kind === "bank" ? "fleet" : null);
	if (!toRaw) die(`--to is required\n${ASK_USAGE}`);
	let route: ReturnType<typeof parseRoute>;
	let priority: ReturnType<typeof parsePriority>;
	try {
		route = parseRoute(toRaw);
		priority = parsePriority(arg("--priority"));
	} catch (e) {
		return die((e as Error).message);
	}
	if (route.kind === "hub")
		die(
			"hub routes ride `coord consult --hub` (the W934 federation leg) until the hub /v1/consult face is the default",
		);
	const out = await submitConsult(
		db,
		{
			asker: as,
			route,
			question,
			priority,
			blocking: !rest.includes("--non-blocking"),
			kind,
			scope: arg("--scope"),
		},
		liveDeps(),
		coordSettings(),
	);
	console.log(out.text);
}

export function cmdConsultDefer(rest: string[]): void {
	const as = arg("--as");
	const reason = arg("--reason") ?? "";
	const cid = rest.find((r) => /^C?\d+$/i.test(r));
	if (!as || !cid)
		die('usage: consult-defer <C##> --reason "<why>" --as <recipient-sid>');
	const err = deferConsult(
		db,
		Number(cid.replace(/^C/i, "")),
		as,
		reason,
		liveDeps(),
	);
	if (err) die(err);
	console.log(`DEFERRED ${cid.toUpperCase()} — asker notified`);
}

export function cmdConsultTick(_rest: string[]): void {
	const out = tickConsults(db, liveDeps(), coordSettings());
	for (const s of out.steered)
		console.log(
			`steer → ${s.recipient.slice(0, 8)}: ${s.ids.map((i) => `C${i}`).join(", ")}`,
		);
	for (const e of out.escalated) console.log(`escalate C${e.id} → ${e.step}`);
	if (!out.steered.length && !out.escalated.length)
		console.log("consult-tick: nothing due");
}

/** consult-reply hook: a fleet-routed v2 consult takes the first answer from
 *  any lane. */
export function fleetAnswerable(id: number): boolean {
	ensureConsultV2(db);
	const r = db
		.query("SELECT route_to, class FROM consults WHERE id = ?")
		.get(id) as { route_to: string | null; class: string | null } | null;
	return r?.route_to === "fleet";
}

export function settleAnswer(id: number, by: string): void {
	try {
		settleFleetAnswer(db, id, by, liveDeps());
	} catch {} // the answer is durable; the settle marker is best effort
}

/** Mirror asker feedback into knowledge_votes (failed = down, resolved =
 *  up); a downvote crossing the lane threshold parks the entry for review. */
export function recordKnowledgeVotes(
	c: { id: number; project: string; question: string },
	entryIds: number[],
	feedback: string,
	evidence: string,
	as: string,
): string {
	if (feedback !== "failed" && feedback !== "resolved") return "no vote";
	const threshold = coordSettings().knowledge.downvote_threshold;
	try {
		return withKnowledgeDb((kb) =>
			entryIds
				.map((entryId) => {
					const v = applyVote(
						kb,
						{
							entryId,
							vote: feedback === "failed" ? "down" : "up",
							lane: as,
							consultId: c.id,
							evidence,
							project: c.project,
						},
						threshold,
					);
					return `k#${entryId} votes up ${v.tally.up} down ${v.tally.down} (${v.tally.downLanes}/${threshold} lanes)${v.demoted ? " — demoted out of answering, parked for review" : ""}`;
				})
				.join("; "),
		);
	} catch (e) {
		return `votes not recorded: ${(e as Error).message}`;
	}
}

/** A failed knowledge answer re-delivers the consult through the normal
 *  interrupt/BTW routing (oracle skipped) — v2 rows only: legacy consult
 *  rows carry no route to replay. */
export async function redeliverAfterFailedKnowledge(
	id: number,
): Promise<string | null> {
	ensureConsultV2(db);
	const r = db
		.query(
			"SELECT asker_sid, question, scope, priority, kind, route_to, blocking FROM consults WHERE id = ?",
		)
		.get(id) as {
		asker_sid: string;
		question: string;
		scope: string | null;
		priority: string | null;
		kind: string | null;
		route_to: string | null;
		blocking: number | null;
	} | null;
	if (!r?.route_to) return null;
	const out = await submitConsult(
		db,
		{
			asker: r.asker_sid,
			route: parseRoute(r.route_to),
			question: r.question,
			priority: parsePriority(r.priority),
			blocking: r.blocking !== 0,
			kind: (r.kind ?? "ask") as ConsultKind,
			scope: r.scope,
			skipOracle: true,
		},
		liveDeps(),
		coordSettings(),
	);
	return `re-delivered C${id} as ${out.text}`;
}
