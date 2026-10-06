// hooks/board/routes-data.ts — read feeds: /api/data /api/decisions /api/tasks /api/task /api/activity /api/setup /api/executors (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { db } from "./context.ts";
import { recoverySnapshot } from "./recovery.ts";
import { beltRegistry, rowLocality } from "./belt.ts";
import { localSwarmEntries } from "./local-swarm.ts";
import { json } from "./helpers.ts";
import { syncDecisions, projectList, unblockedBy } from "./lanes.ts";
import { decisionEvals } from "./decide-eval.ts";
import { readUserPlane } from "../lib/repo-laws.ts";
import { loadLastKnown } from "../lib/federation.ts";
import { hubModelIdsFrom } from "../lib/provenance.ts";
import {
	taskShape,
	tasks,
	workEvents,
	taskDecisions,
	activity,
	setupChecks,
	decisionsPayload,
	payload,
	payloadFor,
} from "./data.ts";

// W183.1 — plane-labeled executor feed. Four planes (provenance.ts/
// repo-laws.ts's own vocabulary, not invented here): "local" (this
// machine's own swarm, registry.ts), "user" (BYO local-models.json,
// repo-laws.ts readUserPlane), "hub" (federation-entitled — W154's
// loadLastKnown + hubModelIdsFrom), "remote" (everything else: direct
// LAN/cloud belt endpoints). locality stays "local"|"remote" for back-compat
// (existing UI badge logic); plane is the new, finer-grained field.
export interface ExecutorEntry {
	value: string;
	label: string;
	model: string;
	locality: "local" | "remote";
	plane: "local" | "user" | "hub" | "remote";
	reasoningEffort: boolean;
}

export async function handleData(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/recovery")
		return json(recoverySnapshot(db, url.searchParams.get("project")));
	if (url.pathname === "/api/data") {
		const sid = url.searchParams.get("session") ?? "";
		return json(sid ? payloadFor(sid) : payload());
	}
	{
		// W217/W273/W292: the vendored Lit component bundles (offline — built
		// artifacts, never CDN) plus the shared lit chunk emitted by
		// build:vendor (--chunk-naming lit-shared.[ext]). Anything else
		// falls through.
		const vf = url.pathname.slice("/vendor/".length);
		const isLitChunk =
			vf.startsWith("lit-") && vf.endsWith(".js") && !vf.includes("/");
		if (
			url.pathname.startsWith("/vendor/") &&
			(vf === "klh-components.js" ||
				vf === "klh-service-row.js" ||
				vf === "klh-recovery.js" ||
				isLitChunk)
		) {
			const f = `${import.meta.dir}/../board-html/vendor/${vf}`;
			return new Response(Bun.file(f), {
				headers: { "content-type": "text/javascript; charset=utf-8" },
			});
		}
	}
	if (url.pathname === "/api/decisions")
		// full decision records + counts — the decisions feed the UI polls.
		// Default OPEN-only; &history=1 folds in the resolved rows
		return json(decisionsPayload(url.searchParams.get("history") === "1"));
	{
		// W217: evaluation history for one decision (the card's hydrate feed)
		const m = url.pathname.match(/^\/api\/decisions\/(\d+)\/evals$/);
		if (m)
			return json({
				ok: true,
				event_id: Number(m[1]),
				evals: decisionEvals(Number(m[1])),
			});
	}
	if (url.pathname === "/api/tasks") {
		// v3 tasks feed (docs/board-api.md) — every live work item, newest
		// activity first, with open fork counts and human owner labels
		syncDecisions(); // fork counts must reflect events the poll hasn't seen
		const p = url.searchParams.get("project");
		return json({ ok: true, projects: projectList(), tasks: tasks(p) });
	}
	if (url.pathname === "/api/task") {
		// detail drawer feed: the item, its bus events, its decisions
		syncDecisions();
		const p = url.searchParams.get("project") ?? "";
		const id = url.searchParams.get("id") ?? "";
		const w = db
			.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
			.get(p, id) as WorkItemRow | null;
		if (!w)
			return json(
				{
					ok: false,
					error: `no work item ${id || "(none)"} in ${p || "(no project)"}`,
				},
				404,
			);
		const openN = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM decisions WHERE state = 'OPEN' AND project = ? AND task_id = ?",
				)
				.get(p, id) as { n: number }
		).n;
		return json({
			ok: true,
			projects: projectList(),
			task: taskShape(w, openN, unblockedBy()),
			events: workEvents(p, id),
			decisions: taskDecisions(p, id),
		});
	}
	if (url.pathname === "/api/activity") {
		// newest-first bus feed; limit default 80, cap 300
		const p = url.searchParams.get("project");
		const limit = Math.min(
			Math.max(Number(url.searchParams.get("limit")) || 80, 1),
			300,
		);
		return json({
			ok: true,
			projects: projectList(),
			events: activity(p, limit),
		});
	}
	if (url.pathname === "/api/setup")
		// advisory wiring checks — each carries its own fix, never throws
		return json({ ok: true, checks: await setupChecks() });
	if (url.pathname === "/api/executors") {
		// W183.1 — plane-labeled, merged dispatch feed: this machine's own
		// swarm (prime position — it's the fastest, cheapest, most-private
		// option when it's up) + BYO user-plane entries + belt's live
		// endpoints, each carrying plane/locality/reasoningEffort so the UI
		// can badge L/R, prefix [HUB], and surface an effort dial.
		const hubIds = hubModelIdsFrom(loadLastKnown());
		const swarm = await localSwarmEntries();
		const local: ExecutorEntry[] = swarm.map((s) => ({
			value: `llm:local:${String(s.port)}`,
			label: `${s.label}${s.ok ? "" : " (down)"}`,
			model: s.model,
			locality: "local",
			plane: "local",
			reasoningEffort: s.reasoningEffort,
		}));
		const user: ExecutorEntry[] = readUserPlane().entries.map((u) => ({
			value: `llm:user:${u.name}`,
			label: `${u.name} · ${u.model} (user)`,
			model: u.model,
			locality: "remote",
			plane: "user",
			reasoningEffort: u.roles?.includes("reasoning") ?? false,
		}));
		const rows = await beltRegistry();
		const llms: ExecutorEntry[] = [];
		for (const r of rows) {
			if (r.protocol !== "openai") continue;
			const tail = r.model ?? String(r.port ?? "");
			if (!r.machine || !tail) continue;
			const loc = rowLocality(r);
			const plane = hubIds.has(tail) ? "hub" : "remote";
			llms.push({
				value: `llm:${r.machine}:${tail}`,
				label: `${plane === "hub" ? "[HUB] " : ""}${r.machine} · ${tail}${r.ok === false ? " (down)" : ""} (${loc})`,
				model: r.model ?? tail,
				locality: loc,
				plane,
				reasoningEffort: r.roles?.includes("reasoning") ?? false,
			});
		}
		return json({
			ok: true,
			executors: [
				...local,
				...user,
				{
					value: "claude",
					label: "claude",
					model: "claude",
					locality: "remote",
					plane: "remote",
					reasoningEffort: false,
				},
				{
					value: "codex",
					label: "codex",
					model: "codex",
					locality: "remote",
					plane: "remote",
					reasoningEffort: false,
				},
				{
					// W223.1 — fourth lane executor; fleet-loop.ts/
					// routes-actions.ts already dispatch it with the right
					// non-interactive flags (-p --allow-all-tools --allow-all-paths).
					// W183.1 — copilot's --reasoning-effort flag is real.
					value: "copilot",
					label: "copilot",
					model: "copilot",
					locality: "remote",
					plane: "remote",
					reasoningEffort: true,
				},
				...llms,
			],
		});
	}
	return null;
}
