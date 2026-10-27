// hooks/board/decisions.ts — the decisions feed: records + payload,
// batched advice/role/payload lookups, per-item decision rows.
// W1255.4: moved verbatim from board/data.ts (per-domain split, THEN.B).
import { usableRecommendation } from "../lib/govdb/advice-quality.ts";
import { db } from "./context.ts";
import { collapseDups } from "./decision-dups.ts";
import { chunked } from "./helpers.ts";
import {
	ago,
	decisionVerdicts,
	labelFrom,
	labelMaps,
	payloadOf,
	syncDecisions,
} from "./lanes.ts";

// decisions linked to the item, any state — the drawer shows the full story
export function taskDecisions(p: string, id: string): unknown[] {
	return (
		db
			.query(
				"SELECT event_id, state, question, answer_note FROM decisions WHERE project = ? AND task_id = ? ORDER BY event_id DESC",
			)
			.all(p, id) as {
			event_id: number;
			state: string;
			question: string | null;
			answer_note: string | null;
		}[]
	).map((d) => ({
		event_id: d.event_id,
		state: d.state,
		question: d.question ?? "",
		answer_note: d.answer_note ?? null,
	}));
}

// W685 batched read faces — one IN(...) statement per chunk replaces the
// per-row store RPCs that made a cold payload compute 684 curls ≈ 3.7s.
function factsByKeys(keys: string[]): Map<string, string> {
	const out = new Map<string, string>();
	chunked(keys, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT key, value FROM facts WHERE key IN (${ph})`)
			.all(...chunk) as { key: string; value: string }[])
			out.set(r.key, r.value);
	});
	return out;
}

function sessionsRoles(sids: string[]): Map<string, string> {
	const out = new Map<string, string>();
	chunked(sids.filter(Boolean), (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT sid, role FROM sessions WHERE sid IN (${ph})`)
			.all(...chunk) as { sid: string; role: string | null }[])
			out.set(r.sid, r.role ?? "");
	});
	return out;
}

function eventPayloads(ids: number[]): Map<number, string | null> {
	const out = new Map<number, string | null>();
	chunked(ids, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT id, payload FROM events WHERE id IN (${ph})`)
			.all(...chunk) as { id: number; payload: string | null }[])
			out.set(r.id, r.payload);
	});
	return out;
}

// records per docs/decisions-api.md — legacy column names (event_id/target/
// answered_at/created_at) surface under their contract names at the API.
// OPEN decisions first, then newest resolved; advice (hooks/bin/advise.ts,
// fact advice.<id> or advice.<id>.error) rides along so the card can show
// the recommendation — the LLM advises, the human decides.
// W862: decisions forked from a hub-policy check carry their provenance
// (hub / row id / content pin) straight from the NEED_DECISION payload —
// the board card discloses origin, it never guesses from question text.
const policyProvenance = (
	raw: string | null,
): { hub: string; sha256: string; id: string; source: string } | null => {
	const policy = payloadOf(raw).policy;
	if (!policy || typeof policy !== "object") return null;
	const { hub, sha256, id, source } = policy as Record<string, unknown>;
	if (
		typeof hub !== "string" ||
		!hub ||
		typeof id !== "string" ||
		!id ||
		typeof sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		return null;
	return {
		hub,
		sha256,
		id,
		source: typeof source === "string" ? source : "",
	};
};

export function decisionRecords(
	project: string | null = null,
): Record<string, unknown>[] {
	const selected = project && project !== "all" ? project : null;
	const rows = db
		.query(
			`SELECT d.*, w.title AS task_title, w.state AS task_state FROM decisions d
			LEFT JOIN work_items w ON w.project = d.project AND w.id = d.task_id
			${selected ? "WHERE d.project = ?" : ""}
			ORDER BY (d.state = 'OPEN') DESC, d.event_id DESC LIMIT 200`,
		)
		.all(...(selected ? [selected] : [])) as {
		event_id: number;
		target: string;
		asked_by: string | null;
		project: string | null;
		task_id: string | null;
		question: string | null;
		options: string | null;
		state: string;
		delivery: string | null;
		answer_note: string | null;
		answer_to: string | null;
		answer_token: string | null;
		created_at: number;
		answered_at: number | null;
		ack_ts: number | null;
		task_title: string | null;
		task_state: string | null;
	}[];
	// W667: one batched liveness pass feeds every row — registry verdicts
	// (the `work lanes` surface) with the sessions face as fallback
	const verdicts = decisionVerdicts(
		rows.map((d) => ({ sid: d.target, project: d.project })),
	);
	// W685: the four per-row reads — advice fact, advice error, session role,
	// source-event payload — batch into four IN(...) reads (the profile's
	// 3.7s whale: 684 store RPCs per cold compute → ~7).
	const adviceRows = factsByKeys(
		rows.flatMap((d) => [
			`advice.${d.event_id}`,
			`advice.${d.event_id}.error`,
			`advice.${d.event_id}.requested`,
		]),
	);
	const roles = sessionsRoles(rows.map((d) => d.target));
	const evPayloads = eventPayloads(rows.map((d) => d.event_id));
	const lm = labelMaps();
	return rows.map((d) => {
		let options: { label: string; tradeoff?: string | null }[] = [];
		try {
			options = d.options ? JSON.parse(d.options) : [];
		} catch {}
		let advice: unknown;
		let adviceError: string | undefined;
		const a = adviceRows.get(`advice.${d.event_id}`) ?? null;
		if (a) {
			try {
				const parsed = JSON.parse(a) as { rec?: unknown };
				if (usableRecommendation(parsed.rec)) advice = parsed;
				else adviceError = "stored recommendation is unusable — retry";
			} catch {}
		} else {
			const err = adviceRows.get(`advice.${d.event_id}.error`);
			if (err) adviceError = err.slice(0, 200);
		}
		const role = roles.get(d.target ?? "") ?? "worker";
		// W487 owner-actionable: a fork classified owner-needed, or one whose
		// target session is not RUNNING, must not dead-end on Send-to-lane —
		// the board renders it as an owner ruling and /api/answer resolves it
		// without a lane ack (same accept-set as routes-actions.ts).
		const classification = String(
			payloadOf(evPayloads.get(d.event_id) ?? null).classification ?? "",
		);
		const ownerNeeded =
			classification === "owner-needed" || classification === "owner_needed";
		const targetGone = d.target ? verdicts.get(d.target) === "dead" : true; // legacy no-target rows: gone by definition
		return {
			id: d.event_id,
			project: d.project || null,
			task_id: d.task_id,
			task_title: d.task_title ?? null,
			task_state: d.task_state ?? null,
			asked_by: d.asked_by || d.target,
			asked_by_label: labelFrom(lm, d.asked_by || d.target, role),
			target: d.target,
			question: d.question ?? "",
			options,
			state: d.state,
			delivery: d.delivery || "DELIVERED",
			answer_note: d.answer_note,
			answer_to: d.answer_to,
			answer_token: d.answer_token,
			owner_actionable: ownerNeeded || targetGone,
			owner_reason: ownerNeeded
				? "owner-needed"
				: targetGone
					? "target-dead"
					: null,
			created_ts: d.created_at,
			answered_ts: d.answered_at,
			ack_ts: d.ack_ts,
			age_s: ago(d.created_at),
			advice,
			adviceError,
			advicePending:
				advice || adviceError
					? null
					: (adviceRows.get(`advice.${d.event_id}.requested`) ?? null),
			policy: policyProvenance(evPayloads.get(d.event_id) ?? null),
		};
	});
}

export function decisionsPayload(
	history: boolean,
	project: string | null = null,
): unknown {
	const selected = project && project !== "all" ? project : null;
	// W798: always-fresh — sync + records recompute per call; only /api/data
	// rides the memo (feedMemo).
	syncDecisions();
	const recs = collapseDups(decisionRecords(selected));
	const open = recs.filter((r) => r.state === "OPEN") as {
		project?: string | null;
	}[];
	// the default feed stays OPEN-only; &history=1 adds the resolved rows
	// (ANSWERED / ACKNOWLEDGED / CANCELLED) for the collapsed history view
	const shown = history ? recs : open;
	const byProject: Record<string, number> = {};
	for (const r of open)
		if (r.project) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
	return { ts: Date.now(), count: open.length, byProject, decisions: shown };
}
