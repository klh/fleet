// hooks/lib/consult/consult-delivery.ts — hub design phase 4: the record +
// delivery half of consult v2 over the governor `consults` table. ONE row per
// consult carries class (interrupt|btw), priority, kind, the route, channel
// attempts (ws, steer, inbox) with timestamps, the escalation chain and
// answered_by (lane|knowledge|fleet|human) + the oracle trust state; the
// board's decisions/consult views read it.
//
// Side effects are injected (steer, emit, oracle, bank, clock) so the e2e
// legs drive the real state machine against a scratch db with a fake clock.
// Columns land lazily (guarded ALTERs, the deadline_at precedent) — no
// user_version bump, idempotent on every open.
import type { GovernorStore } from "../govdb/govdb-store.ts";
import type { CoordConfig } from "./consult-config.ts";
import {
	type ClassifyInput,
	type ConsultClass,
	type ConsultKind,
	type ConsultPriority,
	type ConsultRoute,
	classify,
	type EscalationStep,
	interruptDueAt,
	nextEscalation,
	routeText,
} from "./consult-v2.ts";
import { answerMark, type OracleHitShape, type OracleTier } from "./oracle.ts";

const CONSULTS_DDL =
	"CREATE TABLE IF NOT EXISTS consults (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, asker_sid TEXT NOT NULL, expert_sid TEXT NOT NULL, question TEXT NOT NULL, scope TEXT, state TEXT NOT NULL DEFAULT 'OPEN', answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER)";

const V2_COLUMNS: [string, string][] = [
	["deadline_at", "INTEGER"],
	["class", "TEXT"],
	["priority", "TEXT"],
	["kind", "TEXT"],
	["route_to", "TEXT"],
	["blocking", "INTEGER"],
	["channels", "TEXT"],
	["escalation", "TEXT"],
	["answered_by", "TEXT"],
	["trust", "TEXT"],
	["acked_at", "INTEGER"],
	["due_at", "INTEGER"],
	["last_steer_at", "INTEGER"],
	["defer_reason", "TEXT"],
];

const ensured = new WeakSet<object>();
export function ensureConsultV2(db: GovernorStore): void {
	if (ensured.has(db)) return;
	db.run(CONSULTS_DDL);
	const have = new Set(
		(db.query("PRAGMA table_info(consults)").all() as { name: string }[]).map(
			(c) => c.name,
		),
	);
	for (const [c, t] of V2_COLUMNS)
		if (!have.has(c)) db.run(`ALTER TABLE consults ADD COLUMN ${c} ${t}`);
	ensured.add(db);
}

export interface Channel {
	ch: "ws" | "steer" | "inbox" | "knowledge" | "fleet";
	at: number;
	ack?: string;
	note?: string;
}

export interface ConsultRow {
	id: number;
	asker_sid: string;
	expert_sid: string;
	question: string;
	state: string;
	class: ConsultClass | null;
	priority: ConsultPriority | null;
	kind: ConsultKind | null;
	route_to: string | null;
	channels: string | null;
	escalation: string | null;
	answered_by: string | null;
	trust: string | null;
	acked_at: number | null;
	due_at: number | null;
	last_steer_at: number | null;
	deadline_at: number | null;
	created_at: number;
}

export interface OracleAnswer {
	hit: OracleHitShape & { fact?: string | null; topic?: string | null };
	tier: OracleTier;
}

export type SteerAck = "accepted" | "pending" | "failed";

export interface DeliveryDeps {
	project: string;
	now: () => number;
	/** knowledge-first: an eligible hit answers by the plane */
	oracle: (question: string) => Promise<OracleAnswer | null>;
	/** the coord steer path (mid-turn interrupt via the directed inbox seam) */
	steer: (sid: string, text: string, source: string) => SteerAck;
	/** one event: directed (to = sid, durable receipt) or broadcast (to = null) */
	emit: (e: {
		kind: string;
		to: string | null;
		source: string;
		payload: Record<string, unknown>;
	}) => number;
	/** the Kev store/noise/review gate for tells and banks */
	bank?: (title: string, text: string, ref: string) => Promise<string>;
	/** advisory lessons attached when the oracle cannot answer */
	lessons?: (question: string) => string[];
}

export interface ConsultRequest {
	asker: string;
	route: ConsultRoute;
	question: string;
	priority: ConsultPriority;
	kevPriority?: ConsultPriority | null;
	blocking: boolean;
	kind: ConsultKind;
	scope?: string | null;
	/** re-delivery after failed knowledge feedback: skip the oracle */
	skipOracle?: boolean;
}

export interface SubmitOutcome {
	cid: string;
	id: number;
	class: ConsultClass | null;
	outcome: "knowledge" | "steered" | "queued" | "btw" | "banked" | "inbox";
	dueAt?: number;
	text: string;
}

const j = (s: string | null): unknown[] => {
	try {
		return s ? (JSON.parse(s) as unknown[]) : [];
	} catch {
		return [];
	}
};

function row(db: GovernorStore, id: number): ConsultRow {
	return db.query("SELECT * FROM consults WHERE id = ?").get(id) as ConsultRow;
}

function pushJson(
	db: GovernorStore,
	id: number,
	col: "channels" | "escalation",
	item: unknown,
): void {
	const cur = j(row(db, id)[col]);
	cur.push(item);
	db.query(`UPDATE consults SET ${col} = ? WHERE id = ?`).run(
		JSON.stringify(cur),
		id,
	);
}

function interruptWindow(
	db: GovernorStore,
	recipient: string,
	sender: string,
): { recipientLastAt: number | null; senderLastAt: number | null } {
	const q = (col: string, v: string) =>
		(
			db
				.query(
					`SELECT MAX(last_steer_at) AS at FROM consults WHERE ${col} = ? AND class = 'interrupt'`,
				)
				.get(v) as { at: number | null }
		).at;
	return {
		recipientLastAt: q("expert_sid", recipient),
		senderLastAt: q("asker_sid", sender),
	};
}

export function steerText(rows: ConsultRow[], lessons: string[] = []): string {
	const head =
		rows.length === 1
			? `CONSULT C${rows[0].id} (interrupt) — answer or defer before continuing`
			: `CONSULTS ${rows.map((r) => `C${r.id}`).join(", ")} (interrupt, coalesced) — answer or defer each before continuing`;
	const qs = rows.map(
		(r) => `  C${r.id} from ${r.asker_sid.slice(0, 8)}: ${r.question}`,
	);
	const how = `  answer: coord consult-reply C## "<answer>" --as <you> · defer: coord consult-defer C## --reason "<why>" --as <you>`;
	const adv = lessons.length
		? [`  lessons (advisory): ${lessons.join(" | ")}`]
		: [];
	return [head, ...qs, how, ...adv].join("\n");
}

/** Submit one consult: oracle first, then classify and deliver. */
export async function submitConsult(
	db: GovernorStore,
	req: ConsultRequest,
	deps: DeliveryDeps,
	cfg: CoordConfig,
): Promise<SubmitOutcome> {
	ensureConsultV2(db);
	const now = deps.now();
	const route = routeText(req.route);
	const single = req.route.kind === "sid" && req.route.sids.length === 1;
	const expert = single && req.route.kind === "sid" ? req.route.sids[0] : "";
	const insert = (state: string, cls: ConsultClass | null): number =>
		Number(
			db
				.query(
					"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at, class, priority, kind, route_to, blocking, channels, escalation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]')",
				)
				.run(
					deps.project,
					req.asker,
					expert,
					req.question,
					req.scope ?? null,
					state,
					now,
					cls,
					req.priority,
					req.kind,
					route,
					req.blocking ? 1 : 0,
				).lastInsertRowid,
		);

	if (req.kind === "bank") {
		const id = insert("BANKED", null);
		const verdict = deps.bank
			? await deps.bank(req.question, req.question, `C${id}`)
			: "unavailable";
		db.query("UPDATE consults SET answer = ? WHERE id = ?").run(
			`kev: ${verdict}`,
			id,
		);
		return {
			cid: `C${id}`,
			id,
			class: null,
			outcome: "banked",
			text: `BANK C${id} kev ${verdict}`,
		};
	}

	if (req.kind === "ask" && !req.skipOracle) {
		const hit = await deps.oracle(req.question);
		if (hit) {
			const id = insert("FACT", null);
			const cid = `C${id}`;
			const mark = answerMark(hit.tier, hit.hit, cid);
			const answer = `${hit.hit.fact ?? ""}\n${mark}`;
			db.query(
				"UPDATE consults SET answer = ?, answered_at = ?, answered_by = 'knowledge', trust = ? WHERE id = ?",
			).run(
				answer,
				now,
				`${hit.hit.state ?? "active"} · ${hit.tier} · hash ${hit.hit.trust ?? "unverified"} · k#${hit.hit.id ?? "?"}`,
				id,
			);
			pushJson(db, id, "channels", { ch: "knowledge", at: now });
			deps.emit({
				kind: "consult.answer",
				to: req.asker,
				source: "oracle",
				payload: {
					consult: cid,
					state: "FACT",
					answered_by: "knowledge",
					answer,
					fact: { id: hit.hit.id, tier: hit.tier, trust: hit.hit.trust },
				},
			});
			return {
				cid,
				id,
				class: null,
				outcome: "knowledge",
				text: `ANSWERED ${cid} from knowledge\n${answer}`,
			};
		}
	}

	const ci: ClassifyInput = {
		route: req.route,
		priority: req.priority,
		kevPriority: req.kevPriority,
		blocking: req.blocking,
		kind: req.kind,
	};
	const cls = classify(ci);
	const id = insert(cls === "interrupt" ? "QUEUED" : "OPEN", cls);
	const cid = `C${id}`;
	const lessons = deps.lessons?.(req.question) ?? [];

	if (cls === "btw") {
		if (req.kind === "tell" && deps.bank) {
			const v = await deps.bank(req.question, req.question, cid);
			db.query("UPDATE consults SET answer = ? WHERE id = ?").run(
				`kev: ${v}`,
				id,
			);
		}
		const targets: (string | null)[] =
			req.route.kind === "sid" ? req.route.sids : [null];
		for (const to of targets)
			deps.emit({
				kind: "consult.btw",
				to,
				source: req.asker,
				payload: {
					consult: cid,
					kind: req.kind,
					q: req.question.slice(0, 200),
				},
			});
		pushJson(db, id, "channels", { ch: "ws", at: now, note: route });
		return {
			cid,
			id,
			class: cls,
			outcome: "btw",
			text: `BTW ${cid} → ${route} (next tool boundary, digest)`,
		};
	}

	const due = interruptDueAt(interruptWindow(db, expert, req.asker), cfg);
	if (due > now) {
		db.query("UPDATE consults SET due_at = ? WHERE id = ?").run(due, id);
		deps.emit({
			kind: "consult.queued",
			to: req.asker,
			source: "consult",
			payload: { consult: cid, to: expert, due_at: due },
		});
		return {
			cid,
			id,
			class: cls,
			outcome: "queued",
			dueAt: due,
			text: `QUEUED ${cid} → ${expert.slice(0, 8)} — interrupt window opens in ${Math.ceil((due - now) / 1000)}s (coalesced with any others)`,
		};
	}
	const ack = deliverSteer(db, expert, [row(db, id)], deps, lessons);
	return {
		cid,
		id,
		class: cls,
		outcome: ack === "failed" ? "inbox" : "steered",
		text:
			ack === "failed"
				? `INBOX ${cid} → ${expert.slice(0, 8)} — lane not steerable; parked in the inbox, asker notified`
				: `STEER ${cid} → ${expert.slice(0, 8)} (${ack})`,
	};
}

function deliverSteer(
	db: GovernorStore,
	recipient: string,
	rows: ConsultRow[],
	deps: DeliveryDeps,
	lessons: string[] = [],
): SteerAck {
	const now = deps.now();
	const ack = deps.steer(recipient, steerText(rows, lessons), "consult");
	for (const r of rows) {
		db.query(
			"UPDATE consults SET state = 'OPEN', due_at = NULL, last_steer_at = ? WHERE id = ?",
		).run(now, r.id);
		pushJson(db, r.id, "channels", {
			ch: "steer",
			at: now,
			ack,
			...(rows.length > 1 ? { note: `coalesced ${rows.length}` } : {}),
		});
		if (ack !== "failed") continue;
		// not steerable (dead lane, kill switch, scrub): the chain jumps
		// straight to the inbox; the next timeout routes to the fleet
		const chain = (j(row(db, r.id).escalation) as { step: string }[]).map(
			(c) => c.step,
		);
		if (chain.includes("inbox")) continue;
		parkInInbox(db, r, deps, "lane not steerable");
		if (!chain.includes("re-steer"))
			pushJson(db, r.id, "escalation", {
				step: "re-steer",
				at: now,
				note: "skipped — not steerable",
			});
		pushJson(db, r.id, "escalation", { step: "inbox", at: now });
	}
	return ack;
}

function parkInInbox(
	db: GovernorStore,
	r: ConsultRow,
	deps: DeliveryDeps,
	why: string,
): void {
	const now = deps.now();
	const cid = `C${r.id}`;
	deps.emit({
		kind: "consult",
		to: r.expert_sid,
		source: r.asker_sid,
		payload: { consult: cid, q: r.question, class: "interrupt", fallback: why },
	});
	pushJson(db, r.id, "channels", { ch: "inbox", at: now, note: why });
	deps.emit({
		kind: "consult.notice",
		to: r.asker_sid,
		source: "consult",
		payload: {
			consult: cid,
			note: `${cid} not acked by ${r.expert_sid.slice(0, 8)} — parked in its inbox (${why})`,
		},
	});
}

export interface TickOutcome {
	steered: { recipient: string; ids: number[] }[];
	escalated: { id: number; step: EscalationStep }[];
}

/** One delivery tick: flush queued interrupts whose window opened (one
 *  coalesced steer per recipient) and walk the escalation chain for
 *  un-acked interrupts. */
export function tickConsults(
	db: GovernorStore,
	deps: DeliveryDeps,
	cfg: CoordConfig,
): TickOutcome {
	ensureConsultV2(db);
	const now = deps.now();
	const out: TickOutcome = { steered: [], escalated: [] };
	const queued = db
		.query(
			"SELECT * FROM consults WHERE class = 'interrupt' AND state = 'QUEUED' ORDER BY id",
		)
		.all() as ConsultRow[];
	const byRecipient = new Map<string, ConsultRow[]>();
	for (const r of queued) {
		const list = byRecipient.get(r.expert_sid) ?? [];
		list.push(r);
		byRecipient.set(r.expert_sid, list);
	}
	for (const [recipient, rows] of byRecipient) {
		const ready = rows.filter(
			(r) => interruptDueAt(interruptWindow(db, recipient, r.asker_sid), cfg) <= now,
		);
		if (!ready.length) continue;
		deliverSteer(db, recipient, ready, deps);
		out.steered.push({ recipient, ids: ready.map((r) => r.id) });
	}
	const open = db
		.query(
			"SELECT * FROM consults WHERE class = 'interrupt' AND state = 'OPEN' AND acked_at IS NULL ORDER BY id",
		)
		.all() as ConsultRow[];
	for (const r of open) {
		const chain = j(r.escalation) as { step: string; at: number }[];
		const last = chain.at(-1)?.at ?? r.last_steer_at ?? r.created_at;
		const step = nextEscalation(
			chain.map((c) => c.step),
			Number(last),
			now,
			cfg,
		);
		if (!step) continue;
		if (step === "re-steer") {
			if (interruptDueAt(interruptWindow(db, r.expert_sid, r.asker_sid), cfg) > now)
				continue; // the budget holds re-steers too
			// chain first: a failed re-steer then jumps straight to the inbox
			pushJson(db, r.id, "escalation", { step, at: now });
			deliverSteer(db, r.expert_sid, [row(db, r.id)], deps);
			out.escalated.push({ id: r.id, step });
			continue;
		}
		if (step === "inbox") parkInInbox(db, r, deps, "no ack");
		else {
			db.query("UPDATE consults SET route_to = 'fleet' WHERE id = ?").run(r.id);
			deps.emit({
				kind: "consult.btw",
				to: null,
				source: r.asker_sid,
				payload: {
					consult: `C${r.id}`,
					q: r.question.slice(0, 200),
					escalated: "no ack from addressee — first verified answer wins",
				},
			});
			pushJson(db, r.id, "channels", { ch: "fleet", at: now });
		}
		pushJson(db, r.id, "escalation", { step, at: now });
		out.escalated.push({ id: r.id, step });
	}
	return out;
}

/** The recipient's explicit ack: defer with a reason (answering goes through
 *  consult-reply). Either one stops the escalation chain. */
export function deferConsult(
	db: GovernorStore,
	id: number,
	sid: string,
	reason: string,
	deps: Pick<DeliveryDeps, "emit" | "now">,
): string | null {
	ensureConsultV2(db);
	const r = row(db, id);
	if (!r) return `no such consult: C${id}`;
	if (r.expert_sid !== sid)
		return `C${id} is addressed to ${r.expert_sid.slice(0, 8)}, not you`;
	if (!["OPEN", "QUEUED"].includes(r.state)) return `C${id} is ${r.state}`;
	if (!reason.trim()) return "defer needs --reason";
	db.query(
		"UPDATE consults SET state = 'DEFERRED', acked_at = ?, defer_reason = ? WHERE id = ?",
	).run(deps.now(), reason, id);
	deps.emit({
		kind: "consult.notice",
		to: r.asker_sid,
		source: sid,
		payload: { consult: `C${id}`, note: `deferred: ${reason}` },
	});
	return null;
}

/** First verified answer wins on fleet-routed consults: losers get a cancel
 *  event so no second lane burns a turn on a settled question. */
export function settleFleetAnswer(
	db: GovernorStore,
	id: number,
	answeredBy: string,
	deps: Pick<DeliveryDeps, "emit" | "now">,
): AnsweredByResult {
	ensureConsultV2(db);
	const r = row(db, id);
	const fleet = r.route_to === "fleet" || r.expert_sid === "";
	const by = fleet && r.expert_sid !== answeredBy ? "fleet" : "lane";
	db.query(
		"UPDATE consults SET answered_by = ?, acked_at = COALESCE(acked_at, ?) WHERE id = ?",
	).run(by, deps.now(), id);
	if (fleet)
		deps.emit({
			kind: "consult.cancel",
			to: null,
			source: answeredBy,
			payload: { consult: `C${id}`, note: "answered — stand down" },
		});
	return { answeredBy: by, cancelled: fleet };
}
export interface AnsweredByResult {
	answeredBy: "fleet" | "lane";
	cancelled: boolean;
}
