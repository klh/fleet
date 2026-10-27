// hooks/board/dispatch-core.ts — the dispatch/unclaim mechanics the action
// routes share (W182): executor vocabulary + total selector, llm:* leg
// resolution, the CAS release, and the /api/start claim+route core — W1298:
// moved verbatim out of routes-actions so the routes decompose by family.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { selectLaneCarrier } from "../../scripts/lib/launch-preflight.ts";
import {
	isSpawnableExecutor,
	LEGACY_DISPATCHABLE_AGENTS,
} from "../lib/executors/registry.ts";
import { projectIdentity, projectRootOf } from "../lib/govdb/govdb.ts";
import { laneSid } from "../lib/lanes/laneslug.ts";
import { beltCheck, rowLocality } from "./belt.ts";
import { CLI, DEMO, db, WORK_CLI } from "./context.ts";
import { laneExecFacts, llmRoute, localSwarmChat, runCli } from "./exec.ts";
import { resolveLlmTarget } from "./executor-catalog.ts";
import { json } from "./helpers.ts";
import { lanesOf, pidAlive, sessionAlive } from "./lanes.ts";
import { specialistByPort } from "./local-swarm.ts";
import { releaseCasRetry } from "./release-cas-retry.ts";

// W182 — executor vocabulary shared by every dispatch route, W831 total
// selector: known spawnable tokens and llm:* pass through; ANYTHING else is
// an explicit refusal — a miss never silently maps onto claude (the wrong-
// backend wake the Chorus spawner-select lift bans). W1811: grok/cline are
// RETIRED from the legacy list (registry LEGACY_DISPATCHABLE_AGENTS) until
// their transcript evidence readers land (claim-check fails their lanes
// closed by name) — they refuse here on the registry miss instead of
// spawning evidence-blind.
export const DISPATCHABLE_AGENTS = LEGACY_DISPATCHABLE_AGENTS;
export function normalizeAgent(raw: string): string | null {
	const token = raw.trim().toLowerCase();
	if (!token) return "claude"; // the GUI's empty-dropdown default
	if (token.startsWith("llm:")) return token;
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
