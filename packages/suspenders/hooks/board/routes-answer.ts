// hooks/board/routes-answer.ts — the decision-answer routes (/api/answer,
// /api/decisions/:id/evaluate, /api/ack, /api/advise) plus the owner-ruling
// + class-ruling cores — W1298: moved verbatim out of routes-actions so the
// near-cap route module decomposes by action family.
import { isDecisionKind } from "../lib/govdb/govdb.ts";
import { CLI, db } from "./context.ts";
import { startDecisionEval } from "./decide-eval.ts";
import { enqueueAdvice } from "./advice-queue.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { decisionTargetAlive, payloadOf, syncDecisions } from "./lanes.ts";

// W487 owner ruling: capture the human's answer directly for the owner when
// the fork must not dead-end on Send-to-lane — classified owner-needed, or
// the target session is not RUNNING. The ruling lands on the bus as an
// owner-recorded ANSWER (no lane target); answer_to keeps the raw stored
// target as the record of the addressee. /api/answer response contract.
function recordOwnerRuling(
	id: number,
	to: string,
	note: string,
	token: string,
): Response {
	const p = Bun.spawnSync(
		[
			process.execPath,
			CLI("coord.ts"),
			"emit",
			"ANSWER",
			"--note",
			note,
			"--as",
			"fleet-board",
			`--decision=${id}`,
			"--ruling=owner",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
	if (p.exitCode !== 0)
		return json({ ok: false, output: out.slice(0, 400), to }, 500);
	const done = db
		.query(
			"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN' AND answer_token = ?",
		)
		.run(note, to, Date.now(), crypto.randomUUID(), id, token);
	return Number(done.changes) === 0
		? json({ ok: false, error: "stale" }, 409)
		: json({ ok: true, ruling: true, to });
}

export async function handleAnswerActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/answer") {
		// the board's single write: relay a human answer into the event bus.
		// Idempotency per docs/decisions-api.md: the client echoes the
		// answer_token it read — the same note on an already-answered fork
		// replays (200 {replay:true}); a stale token (another tab answered
		// or dismissed since) is 409 {error:"stale"}.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? parsed.body?.forEvent ?? 0);
		let to = String(parsed.body?.to ?? "");
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		const token = String(parsed.body?.token ?? "");
		// W798 class ruling: ids = [primary, …members] resolves the whole
		// class in one POST (docs/decisions-api.md)
		if (parsed.body?.ids !== undefined)
			return classRuling(parsed.body.ids, note);
		if (!id || !to || !note || !token)
			return json({ ok: false, error: "missing id, to, note or token" }, 400);
		syncDecisions();
		const row = db
			.query(
				"SELECT state, answer_note, answer_token, answer_to, target, project FROM decisions WHERE event_id = ?",
			)
			.get(id) as {
			state: string;
			answer_note: string | null;
			answer_token: string | null;
			answer_to: string | null;
			target: string | null;
			project: string | null;
		} | null;
		// reject unknown ids instead of silently answering nothing
		if (!row)
			return json({ ok: false, error: `unknown decision id: ${id}` }, 404);
		if (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED")
			return row.answer_note === note
				? json({ ok: true, replay: true, to: row.answer_to })
				: json({ ok: false, error: "stale" }, 409);
		if (row.state !== "OPEN" || row.answer_token !== token)
			return json({ ok: false, error: "stale" }, 409);
		// W487 owner ruling gate: owner-needed classification or a target
		// that is not live (W667: process-backed registry verdict — the
		// sessions row stays RUNNING for dead lanes) resolves here, never
		// via Send-to-lane.
		const classification = String(
			payloadOf(
				(
					db.query("SELECT payload FROM events WHERE id = ?").get(id) as {
						payload: string | null;
					} | null
				)?.payload,
			).classification ?? "",
		);
		const ownerNeeded =
			classification === "owner-needed" || classification === "owner_needed";
		if (ownerNeeded || !decisionTargetAlive(row.target ?? to, row.project))
			return recordOwnerRuling(id, row.target ?? to, note, token);
		// accept full sids, unique prefixes, or live bus aliases (an identity
		// that has emitted before — e.g. a coordinator's chosen --as name)
		const exact = db
			.query("SELECT sid FROM sessions WHERE sid = ?")
			.get(to) as { sid: string } | null;
		if (exact) to = exact.sid;
		else {
			const cands = db
				.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'")
				.all(to) as { sid: string }[];
			if (cands.length === 1) to = cands[0]?.sid;
			else {
				const alias = !!db
					.query("SELECT 1 AS x FROM events WHERE source = ? LIMIT 1")
					.get(to);
				if (!alias)
					return json(
						{
							ok: false,
							error:
								cands.length > 1
									? `ambiguous sid: ${to}`
									: `unknown target session: ${to}`,
						},
						400,
					);
			}
		}
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"ANSWER",
				"--to",
				to,
				"--note",
				note,
				"--as",
				"fleet-board",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json({ ok: false, output: out.slice(0, 400), to }, 500);
		// answered — lifecycle state, correlated to the fork's event id; the
		// WHERE clause guards a concurrent answer (raced → stale, another
		// tab got there first)
		const done = db
			.query(
				"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN' AND answer_token = ?",
			)
			.run(note, to, Date.now(), crypto.randomUUID(), id, token);
		return Number(done.changes) === 0
			? json({ ok: false, error: "stale" }, 409)
			: json({ ok: true, output: out.slice(0, 400), to });
	}
	if (
		req.method === "POST" &&
		/^\/api\/decisions\/\d+\/evaluate$/.test(url.pathname)
	) {
		// W217: re-evaluate an OPEN decision — each call runs a fresh LLM
		// evaluation (local/z.ai via the :4000 shim) and appends a stamped
		// entry; the owner clicks as often as they like (ad nauseum, no cap).
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const id = Number(
			url.pathname.match(/\/api\/decisions\/(\d+)\/evaluate/)?.[1],
		);
		if (!id) return json({ ok: false, error: "bad id" }, 400);
		const row = db
			.query("SELECT state FROM decisions WHERE event_id = ?")
			.get(id) as { state: string } | null;
		if (!row) return json({ ok: false, error: "unknown decision" }, 404);
		if (row.state !== "OPEN")
			return json({ ok: false, error: `decision is ${row.state}` }, 409);
		return json({ ok: true, ...startDecisionEval(id) }, 202);
	}
	if (req.method === "POST" && url.pathname === "/api/ack") {
		// board dismiss = CANCELLED (the UI confirms before calling).
		// Idempotent; monotonic — never un-answers a decision.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? 0);
		if (!id) return json({ ok: false, error: "missing event id" }, 400);
		const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
			kind: string;
		} | null;
		if (!ev) return json({ ok: false, error: `unknown event id: ${id}` }, 404);
		if (!isDecisionKind(ev.kind))
			return json({ ok: false, error: `not a decision event: ${id}` }, 400);
		syncDecisions();
		const row = db
			.query("SELECT state FROM decisions WHERE event_id = ?")
			.get(id) as { state: string } | null;
		if (row && (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED"))
			return json({ ok: false, error: "already answered" }, 409);
		db.query(
			"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(Date.now(), crypto.randomUUID(), id);
		return json({ ok: true });
	}
	if (req.method === "POST" && url.pathname === "/api/advise") {
		// W667: fire hooks/bin/advise.ts detached — it writes fact advice.<id>
		// when the LLM answers; the 1s poll picks it up. A request stamp
		// (advice.<id>.requested) dedupes the window: the detached child can
		// run minutes (belt leg 300s), so re-clicks and the UI's backoff
		// retries ride the in-flight child instead of stacking spawns (the
		// "signal timed out" spam: the client gave up at 8s, the child kept
		// running, every retry spawned another). advise.ts clears the stamp
		// on both terminal writes (advice fact or error fact).
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? 0);
		if (!id) return json({ ok: false, error: "missing event id" }, 400);
		const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
			kind: string;
		} | null;
		if (!ev) return json({ ok: false, error: `unknown event id: ${id}` }, 404);
		if (!isDecisionKind(ev.kind))
			return json({ ok: false, error: `not a decision event: ${id}` }, 400);
		return enqueueAdvice(id);
	}
	return null;
}

// W798 class ruling (docs/decisions-api.md): ids = [primary, …members] —
// one POST resolves the class: every OPEN member gets an owner ruling via
// recordOwnerRuling (own ANSWER bus event, token rotated) without per-member
// tokens — the write token guards the route; answer_token is stale-
// protection for the single-card path.
function classRuling(ids: unknown, note: string): Response {
	const classIds = Array.isArray(ids)
		? (ids as unknown[])
				.map(Number)
				.filter((n) => Number.isInteger(n) && n > 0)
				.slice(0, 50)
		: [];
	if (!classIds.length || !note)
		return json({ ok: false, error: "missing note or valid ids" }, 400);
	syncDecisions();
	const applied: number[] = [];
	const skipped: number[] = [];
	for (const cid of classIds) {
		const r = db
			.query(
				"SELECT target, answer_token FROM decisions WHERE event_id = ? and state = 'OPEN'",
			)
			.get(cid) as {
			target: string | null;
			answer_token: string | null;
		} | null;
		if (!r) {
			skipped.push(cid);
			continue;
		}
		const verdict = recordOwnerRuling(
			cid,
			r.target ?? "",
			note,
			r.answer_token ?? "",
		);
		if (verdict.status === 200) applied.push(cid);
		else skipped.push(cid);
	}
	return json({ ok: true, ruling: true, applied, skipped }, 200);
}
