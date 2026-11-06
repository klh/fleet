#!/usr/bin/env bun
// hooks/bin/hub-orphan-gc.ts — CLI face of the W2321.5 hub orphan GC
// (hooks/lib/fleet-loop/hub-orphan-gc.ts). For every stack hub with a
// lane_gc.repo_root: list origin-marked lane worktrees (.fleet/lane-context
// .json marker) + serve processes scoped to them; reap ONLY where the claim
// is TERMINAL at the authority (the manager-side governor store — W1124.18.2
// phase 1: the authority is lease-movable, this bin reads it wherever it
// lives today), the tree is clean, and the tip is merged-or-pushed. An
// unreachable authority degrades the fire to scan-only (connectivity-gated
// — the MultiKueue runGC law). Dirty/unmerged/detached trees report, never
// remove. refs/recover pin before every delete.
//
//   bun hooks/bin/hub-orphan-gc.ts [--act] [--json] [--hub <name>]
//
// Dry-run is the default (monitor doctrine: alerts first); --act reaps.
// The fleet-loop maintenance registry fires it with --act every 30 min.
// Quiet-hours hubs are skipped (W483: never act into a dark window).
// `.fleet/hub-orphan-gc-paused` in the authority repo (N1, W2661 —
// rogue-reap W827 parity) skips the fire entirely: dry-run exit 1 so a
// monitor still notices the pause. Exit 1 when a dry-run finds reapable
// rows or serves (a human should notice), else 0; 2 on argv misuse.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sshOpts } from "../../deploy/hub-remote.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import {
	gcHub,
	type HubGcTarget,
	type HubGcWorktree,
	shQuote,
} from "../lib/fleet-loop/hub-orphan-gc.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import { inQuietHours, loadStack } from "../lib/stack-config.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

/** The stack hub profile slice toGcTarget reads. */
export interface HubGcProfile {
	deploy?: { ssh?: string; connect_timeout?: number };
	lane_gc?: { repo_root?: string };
	quiet_hours?: string;
}

/** N1 (W2661): the operator kill switch, rogue-reap W827 parity — the
 * file's presence in the authority repo skips every hub fire (checked
 * before loadStack, so a paused GC touches nothing). */
export function gcPaused(repo: string): boolean {
	return existsSync(join(repo, ".fleet", "hub-orphan-gc-paused"));
}

/** Map a stack hub profile to a GC target; null when it carries no
 * lane_gc.repo_root (the hub opts out of hub-exec lane GC entirely). */
export function toGcTarget(
	name: string,
	hub: HubGcProfile,
): HubGcTarget | null {
	const root = hub.lane_gc?.repo_root;
	if (!root) return null;
	return {
		name,
		ssh: hub.deploy?.ssh,
		repoRoot: root,
		connectTimeout: hub.deploy?.connect_timeout,
	};
}

/** The real exec face: one script string per hub host, bounded (ssh argv
 * when remote — the hub-port-heal shape; /bin/sh -c when local). */
export function realGcExec(timeoutMs: number) {
	return (
		target: HubGcTarget,
		script: string,
	): { code: number; out: string } => {
		const argv = target.ssh
			? [
					"ssh",
					...sshOpts({
						deploy: {
							ssh: target.ssh,
							connect_timeout: target.connectTimeout,
						},
					}),
					target.ssh,
					script,
				]
			: ["/bin/sh", "-c", script];
		const p = Bun.spawnSync(argv, {
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
		});
		const out = `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`;
		return { code: p.exitCode ?? 1, out };
	};
}

/** Hub-side ancestry probe: is the branch tip merged into main (merge-base
 * --is-ancestor) and pushed (origin tip equality)? Positive evidence only —
 * a failed/unreachable probe reads NOT merged/pushed, so the row is kept. */
export function ancestryProbe(
	exec: ReturnType<typeof realGcExec>,
): (
	target: HubGcTarget,
	w: HubGcWorktree,
) => { merged: boolean; pushed: boolean } {
	return (target, w) => {
		if (w.branch === "DETACHED") return { merged: false, pushed: false };
		const repo = shQuote(target.repoRoot);
		const br = shQuote(w.branch);
		const merged =
			exec(target, `git -C ${repo} merge-base --is-ancestor ${br} main`)
				.code === 0;
		const tip = exec(target, `git -C ${repo} rev-parse ${br}`);
		const remote = exec(target, `git -C ${repo} rev-parse origin/${br}`);
		const pushed =
			tip.code === 0 &&
			remote.code === 0 &&
			tip.out.trim() !== "" &&
			tip.out.trim() === remote.out.trim();
		return { merged, pushed };
	};
}

async function main(argv: string[]): Promise<number> {
	const SPEC = defineVerb({
		name: "hub-orphan-gc",
		usage:
			"usage: bun hub-orphan-gc.ts [--act] [--json] [--hub <name>] [--repo <dir>] — dry-run default; --repo scopes the authority lookup (default cwd)",
		flags: ["--hub", "--repo"],
		switches: ["--act", "--json"],
	});
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const outcome = parseVerb(SPEC, argv);
	if (!outcome.ok || !outcome.parsed) {
		console.error(outcome.message || SPEC.usage || "bad argv");
		return 2;
	}
	const act = outcome.parsed.flag("--act") === "true";
	const json = outcome.parsed.flag("--json") === "true";
	const only = outcome.parsed.flag("--hub");
	const repo = outcome.parsed.flag("--repo") ?? process.cwd();
	// N1 (W2661): operator kill switch, rogue-reap W827 parity — the file's
	// presence skips every hub fire; dry-run still exits 1 so a monitor sees
	// the pause instead of a silent green.
	if (gcPaused(repo)) {
		console.error(
			"hub-orphan-gc: PAUSED — .fleet/hub-orphan-gc-paused present, no hubs fired",
		);
		return act ? 0 : 1;
	}
	const stack = loadStack();
	const exec = realGcExec(120_000);
	// authority face: the manager-side governor store. openStore throw or a
	// query throw = authority unreachable — gcHub degrades to scan-only.
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
	} catch {
		store = null;
	}
	const claimState = (item: string): string | null => {
		if (!store) throw new Error("authority store unreachable");
		const row = store
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(projectIdentity(repo), item) as { state: string } | undefined;
		return row?.state ?? null;
	};
	const ancestry = ancestryProbe(exec);
	const targets: HubGcTarget[] = [];
	for (const [name, hub] of Object.entries(stack.hubs)) {
		if (typeof only === "string" && name !== only) continue;
		if (inQuietHours(hub)) continue; // W483: never act into a dark window
		const t = toGcTarget(name, hub);
		if (t) targets.push(t);
	}
	const reports = targets.map((t) =>
		gcHub(t, { act, exec, claimState, ancestry }),
	);
	if (json) {
		console.log(JSON.stringify({ act, reports }, null, 2));
	} else {
		for (const r of reports) {
			for (const row of r.rows)
				console.log(`${r.hub} ${row.action} ${row.branch} — ${row.why}`);
			for (const s of r.serves)
				console.log(`${r.hub} serve pid=${s.pid} item=${s.item} ${s.cmd}`);
			const tail =
				r.reaped || r.survivors || r.killed
					? ` reaped=${r.reaped} survivors=${r.survivors} killed=${r.killed}`
					: "";
			// N3 (W2661): hub-connectivity loss and authority loss are
			// different failures — the listing never ran vs claims unreadable.
			// Never label a failed listing "AUTHORITY UNREACHABLE".
			const status = r.listingFailed
				? " · HUB UNREACHABLE (no listing — nothing scanned)"
				: r.authorityReachable
					? ""
					: " · AUTHORITY UNREACHABLE (scan-only)";
			console.log(
				`${r.hub}: ${r.rows.length} row(s)${tail}${status}${r.dryRun ? " · dry-run" : ""}`,
			);
		}
	}
	const reapable = reports.some(
		(r) => r.rows.some((x) => x.action === "would-reap") || r.serves.length > 0,
	);
	// act-mode surfacing: one plane event when the fire did anything
	if (act && reports.some((r) => r.reaped + r.survivors + r.killed > 0)) {
		try {
			emitLoopEvent(
				"plane.hub-orphan-gc",
				"plane",
				{
					reports: reports.map((r) => ({
						hub: r.hub,
						reaped: r.reaped,
						survivors: r.survivors,
						killed: r.killed,
						unreachable: !r.authorityReachable,
						listingFailed: r.listingFailed,
					})),
				},
				store ?? openStore(),
			);
		} catch {}
	}
	store?.close?.();
	return !act && reapable ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
