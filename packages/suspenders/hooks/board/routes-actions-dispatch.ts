// hooks/board/routes-actions-dispatch.ts — the dispatch/advice machinery
// behind the board's write routes, moved verbatim from routes-actions.ts
// (W1238.6.5 decompose): the advice queue/worker (recoverPendingAdvice,
// requestAdvice), the W487 owner ruling, the W831 executor vocabulary +
// llm:* leg resolution, the W873 CAS claim release and the W65/W182
// dispatch core. routes-actions.ts keeps route validation + response
// shaping and imports this face.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { selectLaneCarrier } from "../../scripts/lib/launch-preflight.ts";
import { isSpawnableExecutor } from "../lib/executors/registry.ts";
import { projectIdentity, projectRootOf } from "../lib/govdb.ts";
import { laneSid } from "../lib/laneslug.ts";
import { beltCheck, rowLocality } from "./belt.ts";
import { CLI, DEMO, db, WORK_CLI } from "./context.ts";
import { laneExecFacts, llmRoute, localSwarmChat, runCli } from "./exec.ts";
import { resolveLlmTarget } from "./executor-catalog.ts";
import { json } from "./helpers.ts";
import { lanesOf, pidAlive, sessionAlive } from "./lanes.ts";
import { specialistByPort } from "./local-swarm.ts";
import { releaseCasRetry } from "./release-cas-retry.ts";

// W667: /api/advise dedupe window — the detached advise child can run
// minutes (belt leg timeout 300s); within this window re-clicks and UI
// backoff retries ride the in-flight child (inFlight:true) instead of
// stacking spawns. advise.ts clears the stamp on its terminal writes.
const ADVISE_INFLIGHT_MS = 120_000;
const adviceQueue: number[] = [];
const adviceQueued = new Set<number>();
let adviceRunning = false;
const advicePidKey = (id: number) => `advice.${id}.workerPid`;

/** launchd can terminate advice workers with the board; replay those requests. */
export function recoverPendingAdvice(): void {
	const rows = db
		.query("SELECT key FROM facts WHERE key GLOB 'advice.*.requested'")
		.all() as { key: string }[];
	for (const row of rows) {
		const id = Number(/^advice\.(\d+)\.requested$/.exec(row.key)?.[1]);
		if (!Number.isSafeInteger(id) || id <= 0) continue;
		const outcome = db
			.query("SELECT key FROM facts WHERE key IN (?, ?) LIMIT 1")
			.get(`advice.${id}`, `advice.${id}.error`);
		if (outcome) {
			db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
				row.key,
				advicePidKey(id),
			);
			continue;
		}
		const pidRow = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(advicePidKey(id)) as { value: string } | null;
		if (pidRow && pidAlive(Number(pidRow.value))) continue;
		adviceQueue.push(id);
		adviceQueued.add(id);
	}
	runNextAdvice();
}

// The pinned local-reason leg has only two slots, shared with agents. Board
// clicks run one at a time rather than flooding that model with 503s.
function runNextAdvice(): void {
	if (adviceRunning) return;
	const id = adviceQueue.shift();
	if (id === undefined) return;
	adviceRunning = true;
	db.query("UPDATE facts SET value = 'running', ts = ? WHERE key = ?").run(
		Date.now(),
		`advice.${id}.requested`,
	);
	try {
		const child = Bun.spawn(
			[process.execPath, CLI("advise.ts"), String(id), "--panel"],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const pending = db
			.query("SELECT key FROM facts WHERE key = ?")
			.get(`advice.${id}.requested`);
		if (pending)
			db.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
			).run(advicePidKey(id), String(child.pid), Date.now());
		void child.exited.then(
			(code) =>
				finishAdvice(id, code === 0 ? null : `advice worker exited ${code}`),
			(error: unknown) =>
				finishAdvice(
					id,
					error instanceof Error ? error.message : String(error),
				),
		);
	} catch (error) {
		finishAdvice(id, error instanceof Error ? error.message : String(error));
	}
}

function finishAdvice(id: number, failure: string | null): void {
	const key = `advice.${id}`;
	const outcome = db
		.query("SELECT key FROM facts WHERE key IN (?, ?) LIMIT 1")
		.get(key, `${key}.error`) as { key: string } | null;
	if (!outcome)
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
		).run(
			`${key}.error`,
			failure ?? "advice worker stopped without a result",
			Date.now(),
		);
	db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
		`${key}.requested`,
		advicePidKey(id),
	);
	adviceQueued.delete(id);
	adviceRunning = false;
	runNextAdvice();
}

// W487 owner ruling: capture the human's answer directly for the owner when
// the fork must not dead-end on Send-to-lane — classified owner-needed, or
// the target session is not RUNNING. The ruling lands on the bus as an
// owner-recorded ANSWER (no lane target); answer_to keeps the raw stored
// target as the record of the addressee. /api/answer response contract.
export function recordOwnerRuling(
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
export const DISPATCHABLE_AGENTS = ["codex", "copilot", "grok", "cline"];
export function normalizeAgent(raw: string): string | null {
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
export async function resolveLlmLeg(executor: string): Promise<string[]> {
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
export class LlmLegError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

// W182 — shared unclaim core: live-lane check, the bank-capsule signal,
// and the CAS release. Returns a Response in all cases; `dispatched:false`
// tells /api/reassign the old lane still lives (dispatch must wait).
export async function releaseClaimCas(
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
export async function dispatchStart(
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

// W667 /api/advise leg, moved verbatim from the route branch (W1238.6.5
// decompose): the route validates the event, then hands off here — the
// stamp/queue/worker state lives in THIS module alongside the worker.
export function requestAdvice(id: number): Response {
	const stamp = `advice.${id}.requested`;
	const inflight = db
		.query("SELECT ts FROM facts WHERE key = ?")
		.get(stamp) as { ts: number } | null;
	if (
		adviceQueued.has(id) ||
		(inflight && Date.now() - inflight.ts < ADVISE_INFLIGHT_MS)
	)
		return json({ ok: true, started: false, inFlight: true });
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
	).run(stamp, adviceRunning ? "queued" : "running", Date.now());
	db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
		`advice.${id}`,
		`advice.${id}.error`,
	);
	adviceQueue.push(id);
	adviceQueued.add(id);
	const queued = adviceRunning;
	runNextAdvice();
	return json({ ok: true, started: !queued, queued });
}
