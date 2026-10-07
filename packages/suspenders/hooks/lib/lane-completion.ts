import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "./run.ts";
import type { HookInput } from "./hookio.ts";

type Context = {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
	worktree?: string;
};
const productPath = (path: string): boolean =>
	!/^((\.fleet|\.claude|node_modules)(\/|$)|\.klh-brief\.md$|\.workgraph\.jsonl$)/.test(
		path,
	);

/** Claimed lane completion is separate from formatter/knowledge loop guards. */
export function laneCompletion(
	hook: HookInput & { last_assistant_message?: string },
): string | null {
	const cwd = hook.cwd;
	if (!cwd || !existsSync(cwd)) return null;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) return null;
	const wt = top.out.trim();
	let context: Context | undefined;
	try {
		const local = join(wt, ".fleet/lane-context.json");
		if (existsSync(local)) context = JSON.parse(readFileSync(local, "utf8"));
		else {
			const common = run("git", ["rev-parse", "--git-common-dir"], { cwd: wt });
			if (!common.ok) return null;
			const index = join(
				dirname(resolve(wt, common.out.trim())),
				".fleet/lanes.json",
			);
			const rows = JSON.parse(readFileSync(index, "utf8")) as Context[];
			const matches = rows.filter(
				(row) => row.worktree && resolve(row.worktree) === wt,
			);
			if (matches.length === 1) context = matches[0];
		}
	} catch {
		return null;
	}
	if (!context?.sid || !context.item) return null;
	const bin = resolve(import.meta.dir, "../bin");
	const show = run(
		process.execPath,
		[join(bin, "work.ts"), "show", context.item, "--json"],
		{ cwd: wt },
	);
	if (!show.ok)
		return "STOP-GATE: cannot verify this lane's work claim; restore the control plane before stopping.";
	let row: { owner_sid?: string; state?: string };
	try {
		row = JSON.parse(show.out);
	} catch {
		return "STOP-GATE: invalid structured work state.";
	}
	if (
		row.owner_sid !== context.sid ||
		!["CLAIMED", "RUNNING"].includes(row.state ?? "")
	)
		return null;
	const status = Bun.spawnSync(
		["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ cwd: wt, stdout: "pipe", stderr: "pipe" },
	);
	if (status.exitCode !== 0) return "STOP-GATE: cannot verify lane changes.";
	if (
		status.stdout
			.toString()
			.split("\0")
			.filter(Boolean)
			.some((field) => productPath(field.slice(3)))
	)
		return null;
	// Older live lanes predate baseline stamping; use their recorded launch time.
	const baseline =
		context.baseline ??
		(context.launchedAt
			? run(
					"git",
					[
						"rev-list",
						"-1",
						`--before=${new Date(context.launchedAt).toISOString()}`,
						"HEAD",
					],
					{ cwd: wt },
				).out.trim()
			: "");
	if (baseline) {
		const committed = run("git", ["diff", "--name-only", baseline, "HEAD"], {
			cwd: wt,
		});
		if (
			committed.ok &&
			committed.out.split("\n").filter(Boolean).some(productPath)
		)
			return null;
	}
	const dir = join(wt, ".fleet");
	mkdirSync(dir, { recursive: true });
	const marker = join(dir, "completion-attempt.json");
	let tries = 0;
	try {
		const previous = JSON.parse(readFileSync(marker, "utf8"));
		if (
			previous.sid === context.sid &&
			previous.launchedAt === context.launchedAt
		)
			tries = previous.tries;
	} catch {}
	const declaration = /^(NO_OP|BLOCKED)\s+(\S+):\s*(.{10,})$/m.exec(
		hook.last_assistant_message ?? "",
	);
	const declared = declaration?.[2] === context.item;
	if (tries < 2 && !declared) {
		writeFileSync(marker, JSON.stringify({ ...context, tries: tries + 1 }));
		return `STOP-GATE: ${context.item} is claimed by ${context.sid} but has no product edits or commits since dispatch. Execute the brief. If genuinely blocked or a no-op, declare BLOCKED ${context.item}: <specific reason> or NO_OP ${context.item}: <specific reason>. Re-ask ${tries + 1}/2; exhaustion records FAILED, never DONE.`;
	}
	const reason = declared
		? (declaration?.[0] ?? "declared blocked")
		: "empty lane exhausted two completion re-asks";
	const failed = run(
		process.execPath,
		[join(bin, "work.ts"), "fail", context.item, "--note", reason],
		{ cwd: wt },
	);
	if (!failed.ok)
		return `STOP-GATE: failed to record incomplete ${context.item}; control-plane intervention required.`;
	writeFileSync(
		marker,
		JSON.stringify({ ...context, tries, outcome: "FAILED", reason }),
	);
	run(
		process.execPath,
		[
			join(bin, "coord.ts"),
			"emit",
			"NEED_DECISION",
			"--scope",
			"suspenders",
			"--as",
			context.sid,
			"--note",
			`${context.item} incomplete: ${reason}. Review before retrying.`,
		],
		{ cwd: wt },
	);
	return null;
}
