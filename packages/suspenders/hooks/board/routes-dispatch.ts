// hooks/board/routes-dispatch.ts — the carrier routes (/api/start,
// /api/ship, /api/release, /api/reassign, /api/cancel, /api/second-opinion),
// original relative route order preserved — W1298: moved verbatim out of
// routes-actions by action family.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectRootOf } from "../lib/govdb/govdb.ts";
import { CLI, DEMO, db, WORK_CLI } from "./context.ts";
import {
	DISPATCHABLE_AGENTS,
	dispatchStart,
	LlmLegError,
	normalizeAgent,
	releaseClaimCas,
	resolveLlmLeg,
} from "./dispatch-core.ts";
import { runCli } from "./exec.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { lanesOf, pidAlive, readShipJson, sessionAlive } from "./lanes.ts";

export async function handleDispatchActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
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
				// W1243.1: a reviewer must survive the board restarting —
				// unref alone kills the child with the parent (finding
				// .review-launch-499-20261023, same class as the scheduler)
				detached: true,
			},
		);
		child.unref();
		return json({ ok: true, item: id, executor, started: true });
	}
	return null;
}
