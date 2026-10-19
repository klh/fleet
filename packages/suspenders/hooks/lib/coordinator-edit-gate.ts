// hooks/lib/coordinator-edit-gate.ts — W834: the coordinator structural-edit
// gate (superlite block-coordinator-edits lift). Chained FIRST in pre-files:
// a session WITHOUT the lane role marker is a coordinator, and coordinators
// dispatch — direct writes land only on the doc surface (*.md: docs/specs/
// plans/briefs) and fleet runtime state (.fleet/**). Role source (the W834
// design ruling this code embodies):
//   1. KLH_SESSION_ROLE=lane        — dispatch-written per-lane --settings
//                                     env (scripts/lib/lane-settings.ts);
//                                     precise, survives recycled pids and
//                                     manual sessions in a worktree.
//   2. fleetlane ancestor walk      — resolveFleetLane() matches the hook
//                                     process chain against .fleet/lanes.json
//                                     — covers executors with no settings
//                                     channel (codex et al).
//   3. KLH_SESSION_ROLE=coordinator — explicit owner override, skips the walk.
//   else                            — coordinator.
// The sid-prefix route was REJECTED (manual sids collide, lanes rename).
// Scope: fleet-shaped repos only (a packages/suspenders ancestor of cwd),
// and only targets INSIDE that root — machine config (~/.config/klh,
// belt.env) and other repos stay untouched: that is the coordinator's ops
// surface (the design question's "this coord session does real ops edits").
// Every block appends to the denied-calls.jsonl audit (W80, hookio deny())
// — the superlite incidents.jsonl analog — and the deny text is the
// dispatch-it-instead redirect. SUSPENDERS_COORD_EDIT_GATE=0 disables
// (owner kill switch, the scrub-gate pattern).
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveFleetLane } from "./fleetlane.ts";
import { deny, type HookInput } from "./hookio.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// Fleet repo root for cwd: the nearest ancestor owning packages/suspenders
// (the monorepo shape; worktrees carry it at their own root). "" = not fleet.
export function fleetRootFor(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(`${dir}/packages/suspenders`)) return dir;
		const up = dirname(dir);
		if (up === dir) return "";
		dir = up;
	}
}

// The coordinator's direct-write surface: docs/specs/plans (*.md) and
// .fleet/** runtime state. Everything else is a lane's job.
export function coordinatorWriteAllowed(filePath: string): boolean {
	if (/\.md$/i.test(filePath)) return true;
	return /(^|\/)\.fleet\//.test(filePath);
}

export type SessionRole = "lane" | "coordinator";

export function sessionRole(cwd: string): SessionRole {
	const r = process.env.KLH_SESSION_ROLE;
	if (r === "coordinator") return "coordinator"; // explicit override, no walk
	if (r === "lane" || resolveFleetLane(cwd)) return "lane";
	return "coordinator";
}

export const coordinatorDenyText = (rel: string): string =>
	`coordinator-edit-gate: ${rel} is a structural repo write — dispatch it instead: work add + dispatch (or work take); lanes carry the write role. Direct coordinator writes: *.md (docs/specs/plans) and .fleet/** only. SUSPENDERS_COORD_EDIT_GATE=0 disables.`;

// W14: void, not never — chained in the pre-files pipeline (one process per
// Edit/Write); deny() exits hard, every other path returns and the chain
// continues. Cheap exits first: kill switch, tool, path, repo scope,
// allowlist — role resolution (the ps walk) pays only on would-be blocks.
export function coordinatorEditGate(hook: HookInput): void {
	if (process.env.SUSPENDERS_COORD_EDIT_GATE === "0") return;
	if (!EDIT_TOOLS.has(hook.tool_name ?? "")) return;
	let f = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path ?? "";
	if (!f) return;
	f = f.replace(/["']/g, "");
	if (f.startsWith("~")) f = `${process.env.HOME ?? ""}${f.slice(1)}`;
	const at = hook.cwd ?? process.cwd();
	const root = fleetRootFor(at);
	if (!root) return; // not a fleet-shaped repo — never gate
	const abs = isAbsolute(f) ? resolve(f) : resolve(root, f);
	if (!abs.startsWith(`${root}/`)) return; // outside the repo: ops surface
	if (coordinatorWriteAllowed(abs)) return; // docs + .fleet surface
	if (sessionRole(at) === "lane") return;
	deny(coordinatorDenyText(abs.slice(root.length + 1)));
}
