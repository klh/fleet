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
// Scope: VERIFIED fleet identity only (W1124.9 — the bare packages/
// suspenders ancestor walk classified stale /tmp lookalikes as Fleet roots
// and blocked valid non-Fleet edits). Two accepted identities:
//   - git repository identity: the monorepo closure (packages/suspenders/
//     hooks/gate.ts) sits AT `git rev-parse --show-toplevel` of cwd — real
//     main checkouts and linked worktrees verify; temp dirs never do.
//   - canonical installed closure: cwd under $SUSPENDERS_PREFIX (default
//     ~/.claude/hooks/suspenders) with the pinned harness-receipt.json.
//   - project enrollment/claim context (W1042): any Git repo whose project
//     .fleet/ carries control-plane runtime state — the dispatch lane
//     registry (lanes.json), a worktree claim context (lane-context.json),
//     or per-session enrollment files (lane-key-*/lane-settings-*) — gates
//     at its own git toplevel, worktrees included. An explicit
//     `.fleet/ungoverned` marker opts the project OUT (wins over every
//     signal); a hand-made .fleet/ with unrelated contents is no evidence.
// Only targets INSIDE that root gate; machine config (~/.config/klh,
// belt.env) and other repos stay untouched: that is the coordinator's ops
// surface (the design question's "this coord session does real ops edits").
// Every block appends to the denied-calls.jsonl audit (W80, hookio deny())
// — the superlite incidents.jsonl analog — and the deny text is the
// dispatch-it-instead redirect. SUSPENDERS_COORD_EDIT_GATE=0 disables
// (owner kill switch, the scrub-gate pattern).
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RECEIPT_FILE } from "./harness-manifest.ts";
import { resolveFleetLane } from "./fleetlane.ts";
import { resolveProject } from "./govdb-project.ts";
import { hookSubagentSuffix } from "./hook-lane.ts";
import { deny, type HookInput } from "./hookio.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Resolve existing ancestors too: Write may create a file or directory tree
 * that does not exist yet, beneath a symlink spelling of a verified root. */
function canonicalTargetPath(path: string): string {
	let ancestor = path;
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(realpathSync(ancestor), ...missing.toReversed());
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) return path;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

// W1042: enrollment/claim evidence — the control-plane-authored runtime
// state a governed project's .fleet/ carries. An explicit `ungoverned`
// marker opts the project OUT and wins over every other signal; a hand-made
// .fleet/ with unrelated contents is no evidence.
const CLAIM_STATE_RE = /^lane-(key|settings)-.+/;

function fleetStateAt(fleetDir: string): boolean {
	if (existsSync(join(fleetDir, "ungoverned"))) return false;
	if (existsSync(join(fleetDir, "lanes.json"))) return true;
	if (existsSync(join(fleetDir, "lane-context.json"))) return true;
	try {
		return readdirSync(fleetDir).some((f) => CLAIM_STATE_RE.test(f));
	} catch {
		return false; // .fleet absent/unreadable — no signal either way
	}
}

// The third verified identity: an enrolled EXTERNAL project (no monorepo
// shape, no installed closure). Evidence sits at the project's .fleet/ —
// the cwd toplevel for a main checkout, the main checkout root when cwd is
// a linked worktree (one project identity per common git dir, W624). The
// gate root stays cwd's own toplevel (W1124.9: verified boundary only).
function enrolledProjectRootFor(dir: string, top: string): string {
	if (!top) return "";
	if (fleetStateAt(join(top, ".fleet"))) return top;
	const { root } = resolveProject(dir);
	return root !== top && fleetStateAt(join(root, ".fleet")) ? top : "";
}

// Fleet repo root for cwd — verified identity, never the bare directory-
// shape ancestor walk (W1124.9): the shape must sit at a VERIFIED boundary.
// Git identity first (`git rev-parse --show-toplevel`; real main checkouts
// and linked worktrees verify, temp dirs never do), then the canonical
// installed closure, then the enrollment/claim context (W1042).
// "" = not fleet — never gated.
export function fleetRootFor(cwd: string): string {
	const dir = resolve(cwd);
	const top = gitToplevelFor(dir);
	if (
		top &&
		existsSync(join(top, "packages", "suspenders", "hooks", "gate.ts"))
	) {
		return top;
	}
	const installed = installedClosureRootFor(dir);
	if (installed) return installed;
	return enrolledProjectRootFor(dir, top);
}

// `git rev-parse` is the authority for repository identity (worktree .git
// pointers, GIT_DIR, bounds): failure = not a repository. The toplevel comes
// back real (symlink-resolved), so it compares equal to real-pathed targets.
function gitToplevelFor(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	if (r.exitCode !== 0) return "";
	return r.stdout.toString().trim();
}

// Canonical installed closure: cwd inside the installed harness prefix
// ($SUSPENDERS_PREFIX, default ~/.claude/hooks/suspenders — the symlinked
// generation face) WITH the pinned harness-receipt.json — the marker
// sync-harness writes per generation. A lookalike dir without the receipt
// is not the closure.
function installedClosureRootFor(cwd: string): string {
	const prefix =
		process.env.SUSPENDERS_PREFIX ||
		join(process.env.HOME ?? "", ".claude", "hooks", "suspenders");
	if (!prefix) return "";
	const candidates = [resolve(prefix)];
	try {
		candidates.push(realpathSync(prefix));
	} catch {}
	for (const base of candidates) {
		if (
			(cwd === base || cwd.startsWith(`${base}/`)) &&
			existsSync(join(base, RECEIPT_FILE))
		) {
			return base;
		}
	}
	return "";
}

// The coordinator's direct-write surface: docs/specs/plans (*.md) and
// .fleet/** runtime state. Everything else is a lane's job.
export function coordinatorWriteAllowed(filePath: string): boolean {
	if (/\.md$/i.test(filePath)) return true;
	return /(^|\/)\.fleet\//.test(filePath);
}

export type SessionRole = "lane" | "coordinator";

export function sessionRole(cwd: string, hook?: HookInput): SessionRole {
	// W1041.2 review case 3: a native Claude child is an executor even under
	// an interactive coordinator — it inherits neither the lane env marker
	// nor a lanes.json registration, so the env/walk ladder alone files it
	// under "coordinator" and blocks its claim-bound worktree edits. The
	// seam's per-hook agent fields are ground truth; inherited env is not,
	// which is why the child check precedes the explicit override.
	if (hook && hookSubagentSuffix(hook)) return "lane";
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
	// The root is real (git resolves symlinks); compare the target's real
	// path too so /tmp-style spellings of an in-root target still gate.
	const real = canonicalTargetPath(abs);
	if (!abs.startsWith(`${root}/`) && !real.startsWith(`${root}/`)) {
		return; // outside the repo: ops surface
	}
	if (coordinatorWriteAllowed(abs)) return; // docs + .fleet surface
	if (sessionRole(at, hook) === "lane") return;
	deny(coordinatorDenyText(abs.slice(root.length + 1)));
}
