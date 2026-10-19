// hooks/board/routes-actions.ts — board writes: /api/answer /api/ack /api/advise /api/comment /api/message /api/start /api/ship (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { CLI, db, DEMO, WORK_CLI } from "./context.ts";
import { beltCheck, rowLocality } from "./belt.ts";
import { resolveLlmTarget } from "./executor-catalog.ts";
import { runCli, laneExecFacts, llmRoute, localSwarmChat } from "./exec.ts";
import { specialistByPort } from "./local-swarm.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import { releaseCasRetry } from "./release-cas-retry.ts";
import { orchRecipient, orchTargets, type OrchRoute } from "./orch-targets.ts";
import {
	syncDecisions,
	pidAlive,
	lanesOf,
	readShipJson,
	sessionAlive,
	decisionTargetAlive,
	payloadOf,
} from "./lanes.ts";
import { decisionEvals, evaluateDecision } from "./decide-eval.ts";
import {
	isDecisionKind,
	projectIdentity,
	projectRootOf,
} from "../lib/govdb.ts";
import { laneSid } from "../lib/laneslug.ts";
import { isSpawnableExecutor } from "../lib/executors/registry.ts";
import { selectLaneCarrier } from "../../scripts/lib/launch-preflight.ts";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// W667: /api/advise dedupe window — the detached advise child can run
// minutes (belt leg timeout 300s); within this window re-clicks and UI
// backoff retries ride the in-flight child (inFlight:true) instead of
// stacking spawns. advise.ts clears the stamp on its terminal writes.
const ADVISE_INFLIGHT_MS = 120_000;

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

// W182 — executor vocabulary shared by every dispatch route, W831 total
// selector: known spawnable tokens and llm:* pass through; ANYTHING else is
// an explicit refusal — a miss never silently maps onto claude (the wrong-
// backend wake the Chorus spawner-select lift bans).
const DISPATCHABLE_AGENTS = ["codex", "copilot", "grok", "cline"];
function normalizeAgent(raw: string): string | null {
	const token = raw.trim().toLowerCase();
	if (!token) return "claude"; // the GUI's empty-dropdown default
	if (token.startsWith("llm:")) return token;
	// registry vocabulary first; the legacy raw-agent list stays for the
	// not-yet-spawnable rows (grok/cline) so their refusal names the truth
	if (isSpawnableExecutor(token)) return token;
	if (DISPATCHABLE_AGENTS.includes(token)) return token;
	return null;
}

// W182 — llm:* leg resolution for /api/second-opinion: the same catalog the
// ▶ dispatch uses, folded to review-lane args. Local swarm ports resolve
// registry-side; other machines ride belt targeting. Throws LlmLegError —
// the route turns it into a JSON error response.
async function resolveLlmLeg(executor: string): Promise<string[]> {
	const rest = executor.slice(4);
	const c1 = rest.indexOf(":");
	const machine = c1 > 0 ? rest.slice(0, c1) : rest;
	const tail = c1 > 0 ? rest.slice(c1 + 1) : "";
	if (machine === "local") {
		const spec = await specialistByPort(Number(tail));
		if (!spec) throw new LlmLegError(`unknown local swarm port ${tail}`, 409);
		return [
			"--llm-url",
			`http://127.0.0.1:${spec.port}/v1/chat/completions`,
			"--llm-model",
			spec.model,
		];
	}
	const target = resolveLlmTarget(await beltCheck(), machine, tail);
	if (!target)
		throw new LlmLegError(
			`unknown llm target ${executor} — belt registry unreachable?`,
			409,
		);
	const { ep, override } = target;
	return [
		"--belt",
		`${machine}:${ep.port ?? 0}:${override ?? ep.model ?? tail}`,
	];
}

// sentinel: the error class the route maps to JSON (kept tiny — the board
// route's try/catch folds it into {ok:false,error} with the status)
class LlmLegError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

// W182 — shared unclaim core: live-lane check, the bank-capsule signal,
// and the CAS release. Returns a Response in all cases; `dispatched:false`
// tells /api/reassign the old lane still lives (dispatch must wait).
async function releaseClaimCas(
	project: string,
	id: string,
	force: boolean,
): Promise<Response> {
	const repo = projectRootOf(project);
	if (!existsSync(repo))
		return json(
			{ ok: false, error: `project directory missing: ${repo}` },
			409,
		);
	const w = db
		.query(
			"SELECT state, owner_sid, updated_at FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, id) as {
		state: string;
		owner_sid: string | null;
		updated_at: number;
	} | null;
	if (!w)
		return json({ ok: false, error: `no work item ${id} in ${project}` }, 404);
	if (!w.owner_sid || !["CLAIMED", "RUNNING", "ORPHANED"].includes(w.state))
		return json(
			{ ok: false, error: `${id} is ${w.state} — nothing to release` },
			409,
		);
	const live =
		sessionAlive(w.owner_sid) ||
		!!lanesOf(repo).find((l) => l.sid === w.owner_sid && pidAlive(l.pid));
	if (live && !force)
		return json(
			{
				ok: false,
				live: true,
				error: `${id}'s lane ${w.owner_sid} looks live — force to signal it to bank its capsule and exit`,
			},
			409,
		);
	if (live && force) {
		// signal FIRST (bank capsule + exit), then the CAS release — the
		// reaper (worktree sweep) retires the tree once the lane exits
		const sig = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				w.owner_sid,
				"--note",
				`board forced release of ${id} — your claim is gone: bank your capsule and exit; do not close the item`,
				`--work=${id}`,
				`--project=${project}`,
				"--as",
				"fleet-board",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (sig.exitCode !== 0) {
			const out = `${sig.stdout.toString()} ${sig.stderr.toString()}`.trim();
			return json(
				{
					ok: false,
					live: true,
					error: `lane signal failed: ${out.slice(0, 200)}`,
				},
				500,
			);
		}
	}
	// W873 — CAS release via `work reclaim`. A non-zero exit is not always a
	// claim change: argv rejections (the verb kit dies before dispatch) are
	// surfaced as-is, a genuinely moved claim gets one re-read + retry
	// against the fresh owner/revision (both legs CAS-guarded, so a retry
	// can never release the wrong claimant), and an unchanged claim means
	// the reclaim gate refused — pass the CLI's own reason through.
	const reclaimArgs = (owner: string, updatedAt: number) => [
		WORK_CLI,
		"reclaim",
		id,
		...(force ? ["--force"] : []),
		"--expect-owner",
		owner,
		"--expect-updated-at",
		String(updatedAt),
		"--json",
	];
	const rel = runCli(reclaimArgs(w.owner_sid, w.updated_at), repo);
	if (rel.code !== 0) {
		// argv rejections are board bugs, not claim races — surface as-is
		if (/(unknown option|usage:)/.test(rel.out))
			return json(
				{
					ok: false,
					error: `reclaim CLI rejected its arguments: ${rel.out.slice(0, 200)}`,
				},
				500,
			);
		return releaseCasRetry(project, id, w, force, repo, rel);
	}
	return json({
		ok: true,
		item: id,
		released: w.owner_sid,
		forced: live && force,
		dispatched: !live,
	});
}

// W182 — the /api/start dispatch core, extracted verbatim so /api/reassign
// reuses the exact claim+route path after its release leg. Everything here
// moved from the inline block; project/id/agent/effort arrive pre-validated.
async function dispatchStart(
	project: string,
	id: string,
	agent: string,
	effort: string,
): Promise<Response> {
	if (DEMO)
		return json({ ok: false, error: "demo board — no real lanes" }, 409);
	// W810: item existence gates FIRST — an unknown id 404s even when the
	// agent binary is unresolvable (the 409 is about the executor, not the
	// item; the reverse order made 404 unreachable on PATH-starved boards)
	const w = db
		.query(
			"SELECT state, owner_sid, project, title, description FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, id) as {
		state: string;
		owner_sid: string | null;
		project: string;
		title: string;
		description: string | null;
	} | null;
	if (!w)
		return json({ ok: false, error: `no work item ${id} in ${project}` }, 404);
	let claude = "";
	if (!agent.startsWith("llm:")) {
		// W831 total carrier selector: the binary resolve is the selector's,
		// not a which()-then-unrelated-fallback chain — a miss names the
		// requested carrier and refuses (W223.1 doctrine, registry-vocab).
		const picked = selectLaneCarrier(agent);
		if (!picked.ok) return json({ ok: false, error: picked.why }, 409);
		claude = picked.bin;
	}
	if (w.owner_sid)
		return json(
			{ ok: false, error: `${id} already claimed by ${w.owner_sid}` },
			409,
		);
	if (w.state !== "READY")
		return json(
			{
				ok: false,
				error: `${id} is ${w.state} — only READY items start a lane`,
			},
			409,
		);
	const repo = projectRootOf(w.project);
	if (!existsSync(repo))
		return json(
			{ ok: false, error: `project directory missing: ${repo}` },
			409,
		);
	if (agent.startsWith("llm:")) {
		// board-forced LLM dispatch: claim the item as the board lane
		// (the same take the agent dispatch uses) so nobody double-
		// dispatches while belt routes; the answer lands as llm.result
		// on the item's thread and the claim releases either way
		const rest = agent.slice(4);
		const c1 = rest.indexOf(":");
		const machine = c1 > 0 ? rest.slice(0, c1) : rest;
		const tail = c1 > 0 ? rest.slice(c1 + 1) : "";
		if (machine === "local") {
			// W183.1 — this machine's own swarm: resolve the port<->
			// model pair straight from registry.ts, no belt hop.
			const port = Number(tail);
			const spec = await specialistByPort(port);
			if (!spec)
				return json(
					{ ok: false, error: `unknown local swarm port ${tail}` },
					409,
				);
			const sid = laneSid(id, projectIdentity(repo));
			const take = runCli(
				[
					WORK_CLI,
					"take",
					id,
					"--as",
					sid,
					"--origin",
					`${hostname()}:llm:local`,
				],
				repo,
			);
			if (take.code !== 0)
				return json(
					{ ok: false, error: `claim failed: ${take.out.slice(0, 300)}` },
					409,
				);
			laneExecFacts(sid, agent, spec.model, "local");
			void localSwarmChat({
				item: id,
				repo,
				port: spec.port,
				model: spec.model,
				sid,
				title: w.title,
				desc: w.description ?? "",
			});
			const claimToken = /claim token: ([0-9a-f]{48})/.exec(
				String(take.out),
			)?.[1];
			return json({ ok: true, item: id, sid, executor: agent, claimToken });
		}
		// W224 — machine+tail resolves through executor-catalog's one
		// reader: a port or default-model pick matches the row directly,
		// a catalog pick falls back to machine-level targeting with the
		// model riding belt's route-to --model. Garbage tails 409.
		const target = resolveLlmTarget(await beltCheck(), machine, tail);
		if (!target)
			return json(
				{
					ok: false,
					error: `unknown llm target ${agent} — belt registry unreachable?`,
				},
				409,
			);
		const { ep, override } = target;
		const role = ep.roles?.includes("general")
			? "general"
			: (ep.roles?.[0] ?? "");
		if (!role)
			return json({ ok: false, error: `${agent} serves no route role` }, 409);
		const sid = laneSid(id, projectIdentity(repo));
		const take = runCli(
			[
				WORK_CLI,
				"take",
				id,
				"--as",
				sid,
				"--origin",
				`${hostname()}:llm:${machine}`,
			],
			repo,
		);
		if (take.code !== 0)
			return json(
				{ ok: false, error: `claim failed: ${take.out.slice(0, 300)}` },
				409,
			);
		laneExecFacts(sid, agent, override ?? ep.model ?? tail, rowLocality(ep));
		void llmRoute({
			item: id,
			repo,
			machine,
			port: ep.port ?? 0,
			model: override,
			target: `${machine}:${override ?? ep.model ?? tail}`,
			sid,
			title: w.title,
			desc: w.description ?? "",
		});
		const claimToken = /claim token: ([0-9a-f]{48})/.exec(
			String(take.out),
		)?.[1];
		return json({ ok: true, item: id, sid, executor: agent, claimToken });
	}
	const sid = laneSid(id, projectIdentity(repo));
	laneExecFacts(sid, agent, agent, "remote");
	const child = Bun.spawn(
		[
			process.execPath,
			CLI("fleet-loop.ts"),
			"dispatch",
			"--repo",
			repo,
			"--item",
			id,
			"--agent",
			agent,
			...(effort ? ["--effort", effort] : []),
		],
		{
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			// a launchd board can miss the user PATH — hand the lane's
			// agent spawn the dir we just resolved it from
			env: {
				...process.env,
				PATH: `${dirname(claude)}:${process.env.PATH ?? ""}`,
			},
		},
	);
	child.unref();
	return json({
		ok: true,
		item: id,
		sid,
	});
}

export async function handleActions(
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
		try {
			const entry = await evaluateDecision(id);
			return json({
				ok: true,
				latest: entry,
				count: decisionEvals(id).length,
			});
		} catch (e) {
			return json(
				{ ok: false, error: e instanceof Error ? e.message : String(e) },
				502,
			);
		}
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
		const stamp = `advice.${id}.requested`;
		const inflight = db
			.query("SELECT ts FROM facts WHERE key = ?")
			.get(stamp) as { ts: number } | null;
		if (inflight && Date.now() - inflight.ts < ADVISE_INFLIGHT_MS)
			return json({ ok: true, started: false, inFlight: true });
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
		).run(stamp, "in-flight", Date.now());
		// W742.2: the advisory card renders panel verdicts + agreement — the
		// detached child fans both oracle legs (advise.ts --panel)
		const child = Bun.spawn(
			[process.execPath, CLI("advise.ts"), String(id), "--panel"],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		child.unref();
		return json({ ok: true, started: true });
	}
	if (req.method === "POST" && url.pathname === "/api/comment") {
		// W55 — review line-comments: route a board note to the item's
		// owning lane over the same coord path /api/answer uses. Mirrors
		// its guards (writeGuard + JSON-only body) and its emit shape
		// (spawnSync argument array, --as fleet-board). Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const file = String(parsed.body?.file ?? "")
			.trim()
			.slice(0, 500);
		const line = String(parsed.body?.line ?? "")
			.trim()
			.slice(0, 20);
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !file || !line || !note)
			return json({ ok: false, error: "missing id, file, line or note" }, 400);
		const w = db
			.query(
				"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { owner_sid: string | null } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!w.owner_sid)
			return json(
				{ ok: false, error: `work item ${id} has no owning lane` },
				404,
			);
		const full = `review ${id} ${file}:${line} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				w.owner_sid,
				"--note",
				full,
				"--as",
				"fleet-board",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json(
				{ ok: false, output: out.slice(0, 400), to: w.owner_sid },
				500,
			);
		return json({ ok: true, to: w.owner_sid });
	}
	if (req.method === "POST" && url.pathname === "/api/message") {
		// W76 — message-to-lane: a general board note routed to the owning
		// lane over coord, emitted as the published coordinator identity
		// (fact `coordinator.sid`; fallback `fleet-board` when unset so the
		// route degrades to the /api/comment identity, never to "unknown").
		// Mirrors /api/comment's guards and emit shape. Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const project = String(parsed.body?.project ?? "");
		const route = String(parsed.body?.target ?? "lane");
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !note)
			return json({ ok: false, error: "missing id or note" }, 400);
		if (route !== "lane" && route !== "parent" && route !== "supervisor")
			return json({ ok: false, error: "unknown message target" }, 400);
		if (route !== "lane" && !project)
			return json(
				{ ok: false, error: "project required for routed message" },
				400,
			);
		const targets = project ? orchTargets(db, project, id) : null;
		const legacy = !project
			? (db
					.query(
						"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
					)
					.get(id) as { owner_sid: string | null } | null)
			: null;
		if (project && !targets)
			return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!project && !legacy)
			return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		const to = targets
			? orchRecipient(targets, route as OrchRoute)
			: (legacy?.owner_sid ?? null);
		if (!to)
			return json(
				{ ok: false, error: `work item ${id} has no ${route} recipient` },
				404,
			);
		const as =
			(
				db
					.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
					.get() as { value: string } | null
			)?.value ?? "fleet-board";
		const full = `board ${id}${project ? ` (${project})` : ""} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				to,
				"--note",
				full,
				"--as",
				as,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json({ ok: false, output: out.slice(0, 400), to }, 500);
		return json({ ok: true, to, as, target: route });
	}
	if (req.method === "POST" && url.pathname === "/api/start") {
		// W65/W182 — start-on-READY: the route validates + normalizes the
		// agent; dispatchStart (extracted verbatim above so /api/reassign can
		// reuse it) owns the claim + route.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const rawAgent = String(parsed.body?.agent ?? "claude");
		// W831 fail-closed carrier: an unknown agent 400s — never a claude wake.
		const agent = normalizeAgent(rawAgent);
		if (!agent)
			return json(
				{
					ok: false,
					error: `unknown carrier ${rawAgent} — not in the executor registry`,
				},
				400,
			);
		const effort = String(parsed.body?.effort ?? "").trim();
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		return dispatchStart(project, id, agent, effort);
	}
	if (req.method === "POST" && url.pathname === "/api/ship") {
		// W64 — one-click ship from the W55 diff drawer: run the repo's merge
		// ladder for ONE branch (suspenders/<id>). Guarded; ladder required.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const w = db
			.query("SELECT project FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { project: string } | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		const repo = projectRootOf(project);
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		const branch = `suspenders/${id}`;
		const git = (args: string[]): { out: string; code: number } => {
			const p = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			return { out: p.stdout.toString(), code: p.exitCode };
		};
		if (
			git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !==
			0
		)
			return json(
				{ ok: false, error: `no branch ${branch} for item ${id}` },
				404,
			);
		const baseBranch = ["main", "master"].find(
			(b) =>
				git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).code === 0,
		);
		if (!baseBranch)
			return json(
				{ ok: false, error: `no main/master branch in ${repo}` },
				404,
			);
		const ahead = Number(
			git(["rev-list", "--count", `${baseBranch}..${branch}`]).out.trim() ||
				"0",
		);
		if (!Number.isFinite(ahead) || ahead <= 0)
			return json(
				{
					ok: false,
					error: `nothing to ship — ${branch} is already merged`,
				},
				409,
			);
		// never ship a branch a live lane still owns: the dispatched-lane pid
		// registry (.fleet/lanes.json) and the owning session's liveness both
		// veto — interactive lanes aren't in lanes.json, hence the second check
		const liveLane = lanesOf(repo).find(
			(l) => l.branch === branch && pidAlive(l.pid),
		);
		if (liveLane)
			return json(
				{
					ok: false,
					error: `a live lane (pid ${liveLane.pid}) still owns ${branch}`,
				},
				409,
			);
		const owner = db
			.query("SELECT owner_sid FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { owner_sid: string | null } | null;
		if (owner?.owner_sid && sessionAlive(owner.owner_sid))
			return json(
				{
					ok: false,
					error: `owning session ${owner.owner_sid} is still live — ship after the lane finishes`,
				},
				409,
			);
		// W101 merge-ladder guard: a live .fleet/merge-active marker means
		// a daemon merge is mid-flight — one-click ship spawned fleet-loop
		// ship, whose blind MERGE_HEAD abort killed the ladder and
		// FAIL-struck the innocent branch. Mirror of fleet-loop's
		// mergeRunnerAlive (same 30-min freshness + ps cmdline identity);
		// the scripts can't share the helper without running the loop's
		// mode dispatch, so this stays a commented twin.
		try {
			const j = JSON.parse(
				readFileSync(`${repo}/.fleet/merge-active`, "utf8"),
			) as { pid: number; cmd?: string; ts: number };
			if (Date.now() - j.ts < 30 * 60_000 && j.cmd) {
				process.kill(j.pid, 0);
				const cmd = Bun.spawnSync(
					["ps", "-o", "command=", "-p", String(j.pid)],
					{ stdout: "pipe", stderr: "pipe" },
				)
					.stdout.toString()
					.trim();
				if (cmd === j.cmd)
					return json(
						{
							ok: false,
							error: `merge ladder in flight (pid ${j.pid}) — ship refused`,
						},
						409,
					);
			}
		} catch {}
		// the ladder is owner config in the repo — REQUIRED (a silent plain
		// merge would bypass the repo's quality policy)
		const ship = readShipJson(repo);
		if (!ship.ladder)
			return json(
				{
					ok: false,
					error: `no ladder configured — add ${repo}/.fleet/ship.json {"ladder":"<cmd template with {branch}>"}`,
				},
				409,
			);
		// detached child: HTTP answers while the ladder runs (ladders test — minutes)
		const child = Bun.spawn(
			[
				process.execPath,
				CLI("fleet-loop.ts"),
				"ship",
				"--repo",
				repo,
				"--branch",
				branch,
				"--ladder",
				ship.ladder,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				// the ladder's own tools (bun/qlty/git) must resolve under launchd
				env: {
					...process.env,
					PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
				},
			},
		);
		child.unref();
		return json({ ok: true, item: id, branch, ladder: ship.ladder });
	}
	if (req.method === "POST" && url.pathname === "/api/release") {
		// W182 — unclaim from the GUI: the release button on claimed cards.
		// A dead lane's claim releases straight away; a LIVE lane refuses until
		// force, which signals it to bank its capsule and exit first (the note
		// lands on the item thread), then CAS-releases. The worktree sweep is
		// the reaper: it retires the tree once the lane is gone — never an
		// orphan.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const force = !!parsed.body?.force;
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		return releaseClaimCas(project, id, force);
	}
	if (req.method === "POST" && url.pathname === "/api/reassign") {
		// W182 — resume-on-another-brain: release the current claim and
		// re-dispatch the SAME deterministic sid on the chosen executor. The
		// coord thread and the capsule fact are keyed by sid, so they ride
		// along untouched — the capsule IS the handoff. When the old lane is
		// still live it is signalled (bank capsule + exit) and the response
		// honestly reports `dispatched:false` — dispatch refuses a live
		// worktree owner, so the ▶ fires after it retires.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const rawAgent = String(parsed.body?.agent ?? "claude");
		// W831 fail-closed carrier: an unknown agent 400s — never a claude wake.
		const agent = normalizeAgent(rawAgent);
		if (!agent)
			return json(
				{
					ok: false,
					error: `unknown carrier ${rawAgent} — not in the executor registry`,
				},
				400,
			);
		const effort = String(parsed.body?.effort ?? "").trim();
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const w = db
			.query(
				"SELECT state, owner_sid, updated_at FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, id) as {
			state: string;
			owner_sid: string | null;
			updated_at: number;
		} | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		if (!w.owner_sid || !["CLAIMED", "RUNNING"].includes(w.state))
			return json(
				{
					ok: false,
					error: `${id} is ${w.state} — reassign moves a live claim; READY items dispatch via /api/start`,
				},
				409,
			);
		const repo = projectRootOf(project);
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		const rel = await releaseClaimCas(project, id, true);
		const relBody = (await rel.json()) as Record<string, unknown>;
		if (!relBody.ok)
			return json(
				{ ok: false, error: `release leg failed: ${String(relBody.error)}` },
				409,
			);
		if (relBody.dispatched === false) return json(relBody); // old lane still live — signalled, dispatch later
		return dispatchStart(project, id, agent, effort);
	}
	if (req.method === "POST" && url.pathname === "/api/cancel") {
		// W182 — CANCELLED from the GUI: close completely with a required
		// reason (the CLI verb does the work; it releases the claim + retires
		// the worktree; NOT in rollUp's satisfied set, so a cancelled child
		// keeps its SHATTERED parent open).
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const reason = String(parsed.body?.reason ?? "")
			.trim()
			.slice(0, 2000);
		if (!project || !id || !reason)
			return json({ ok: false, error: "missing project, id or reason" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const w = db
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { state: string } | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		if (
			["DONE", "FAILED", "SUPERSEDED", "CANCELLED", "SHATTERED"].includes(
				w.state,
			)
		)
			return json(
				{ ok: false, error: `${id} is ${w.state} — already closed` },
				409,
			);
		const repo = projectRootOf(project);
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		const c = runCli([WORK_CLI, "cancel", id, "--note", reason], repo);
		if (c.code !== 0)
			return json(
				{ ok: false, error: `cancel failed: ${c.out.slice(0, 300)}` },
				500,
			);
		return json({ ok: true, item: id, state: "CANCELLED" });
	}
	if (req.method === "POST" && url.pathname === "/api/second-opinion") {
		// W182 — a read-only REVIEW lane (never claims) against the item's
		// diff + claims; W105 executor routing picks the leg. Works on DONE
		// items — reviewing landed work is the point of a second opinion.
		// review-lane.ts runs detached, emits NOTE(s) on the item thread +
		// a work.review verdict event + fact review.<id>.<executor>.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const executor = String(parsed.body?.executor ?? "");
		if (!project || !id || !executor)
			return json({ ok: false, error: "missing project, id or executor" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const w = db
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { state: string } | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		const repo = projectRootOf(project);
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		// W105 executor routing: agent binaries ride --bin; llm:* resolves
		// through the same catalog the ▶ dispatch uses.
		let legArgs: string[] = [];
		let binDir: string | null = null;
		if (DISPATCHABLE_AGENTS.includes(executor)) {
			const bin =
				Bun.which(executor) ??
				(executor === "codex"
					? "/opt/homebrew/bin/codex"
					: `${process.env.HOME}/.local/bin/claude`);
			if (!existsSync(bin))
				return json(
					{
						ok: false,
						error: `${executor} binary not found on the board's PATH`,
					},
					409,
				);
			legArgs = ["--bin", bin];
			binDir = dirname(bin);
		} else if (executor.startsWith("llm:")) {
			try {
				legArgs = await resolveLlmLeg(executor);
			} catch (e) {
				const st = e instanceof LlmLegError ? e.status : 500;
				return json(
					{ ok: false, error: String(e instanceof Error ? e.message : e) },
					st,
				);
			}
		} else {
			return json({ ok: false, error: `unknown executor ${executor}` }, 400);
		}
		const env2 = binDir
			? { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }
			: process.env;
		const child = Bun.spawn(
			[
				process.execPath,
				CLI("review-lane.ts"),
				"--item",
				id,
				"--project",
				project,
				"--executor",
				executor,
				...legArgs,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: env2,
				cwd: repo,
			},
		);
		child.unref();
		return json({ ok: true, item: id, executor, started: true });
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
