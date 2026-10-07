import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HookInput } from "./hookio.ts";
import { run } from "./run.ts";

type Context = {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
	worktree?: string;
};

/** W516: the lane-context resolution shared by laneCompletion and the
 *  stop-gate turn-boundary drain (.fleet/lane-context.json first, else a
 *  unique worktree match in the repo-level .fleet/lanes.json index). */
export function resolveLaneContext(wt: string): Context | undefined {
	try {
		const local = join(wt, ".fleet/lane-context.json");
		if (existsSync(local)) return JSON.parse(readFileSync(local, "utf8"));
		const common = run("git", ["rev-parse", "--git-common-dir"], { cwd: wt });
		if (!common.ok) return undefined;
		const index = join(
			dirname(resolve(wt, common.out.trim())),
			".fleet/lanes.json",
		);
		const rows = JSON.parse(readFileSync(index, "utf8")) as Context[];
		const matches = rows.filter(
			(row) => row.worktree && resolve(row.worktree) === wt,
		);
		return matches.length === 1 ? matches[0] : undefined;
	} catch {
		return undefined;
	}
}

/** Claimed lane completion is separate from formatter/knowledge loop guards. */
export function laneCompletion(
	hook: HookInput & { last_assistant_message?: string },
): string | null {
	const cwd = hook.cwd;
	if (!cwd || !existsSync(cwd)) return null;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) return null;
	const wt = top.out.trim();
	const context = resolveLaneContext(wt);
	if (!context?.sid || !context.item) return null;
	const bin = resolve(import.meta.dir, "../bin");
	const show = run(
		process.execPath,
		[join(bin, "work.ts"), "show", context.item, "--json"],
		{ cwd: wt },
	);
	if (!show.ok)
		return "STOP-GATE: cannot verify this lane's work claim; restore the control plane before stopping.";
	let row: {
		owner_sid?: string;
		state?: string;
		project?: string;
		result_sha?: string;
		completion?: {
			project?: string;
			item?: string;
			summary?: string;
			summary_hash?: string;
			commit_sha?: string;
			completed_by?: string;
		};
	};
	try {
		row = JSON.parse(show.out);
		if (!row || typeof row !== "object" || typeof row.state !== "string")
			return "STOP-GATE: invalid structured work state.";
	} catch {
		return "STOP-GATE: invalid structured work state.";
	}
	if (row.owner_sid && row.owner_sid !== context.sid) return null;
	const marker = join(wt, ".fleet/completion-attempt.json");
	let previous: Record<string, unknown> = {};
	try {
		const value = JSON.parse(readFileSync(marker, "utf8"));
		if (
			value.sid === context.sid &&
			value.item === context.item &&
			value.launchedAt === context.launchedAt
		)
			previous = value;
	} catch {}
	const recordDecision = (reason: string, tries: number): boolean => {
		const decision = run(
			process.execPath,
			[
				join(bin, "coord.ts"),
				"emit",
				"NEED_DECISION",
				"--scope",
				"suspenders",
				"--as",
				context.sid,
				`--project=${row.project}`,
				`--item=${context.item}`,
				"--note",
				`${context.item} incomplete: ${reason}. Review before retrying.`,
			],
			{ cwd: wt },
		);
		writeFileSync(
			marker,
			JSON.stringify({
				...context,
				tries,
				outcome: "FAILED",
				reason,
				decisionPending: !decision.ok,
			}),
		);
		return decision.ok;
	};
	if (row.state === "DONE") {
		const record = row.completion;
		const summary = record?.summary;
		if (
			!record ||
			typeof summary !== "string" ||
			summary.trim().length < 40 ||
			summary.length > 4000 ||
			record.project !== row.project ||
			record.item !== context.item ||
			!record.completed_by ||
			record.commit_sha !== row.result_sha ||
			!record.commit_sha ||
			!/^[a-f0-9]{40}$/i.test(record.commit_sha) ||
			createHash("sha256").update(summary).digest("hex") !== record.summary_hash
		)
			return `STOP-GATE: ${context.item} is DONE without verified saved completion evidence. Restore its work done paragraph and completion record before stopping.`;
		return null;
	}
	if (row.state === "FAILED" && previous.decisionPending === true) {
		if (
			!recordDecision(
				String(previous.reason ?? "lane incomplete"),
				Number(previous.tries) || 0,
			)
		)
			return `STOP-GATE: ${context.item} is FAILED but its NEED_DECISION could not be recorded; restore the control plane.`;
	}
	if (["FAILED", "SPLIT", "SHATTERED", "SUPERSEDED"].includes(row.state ?? ""))
		return null;
	if (!["CLAIMED", "RUNNING"].includes(row.state ?? ""))
		return `STOP-GATE: ${context.item} has no verified terminal outcome or transferred owner; control-plane intervention required.`;
	const dir = join(wt, ".fleet");
	mkdirSync(dir, { recursive: true });
	const tries =
		typeof previous.tries === "number" &&
		Number.isInteger(previous.tries) &&
		previous.tries >= 0
			? previous.tries
			: 0;
	const declaration = /^(NO_OP|BLOCKED)\s+(\S+):\s*(.{10,})$/m.exec(
		hook.last_assistant_message ?? "",
	);
	const declared = declaration?.[2] === context.item;
	if (tries < 2 && !declared) {
		writeFileSync(marker, JSON.stringify({ ...context, tries: tries + 1 }));
		return `STOP-GATE: ${context.item} remains ${row.state} by ${context.sid}. Edits and commits are progress, not completion. Finish with work done ${context.item} --sha <commit> --summary <completion paragraph>. If genuinely blocked or a no-op, declare BLOCKED ${context.item}: <specific reason> or NO_OP ${context.item}: <specific reason>. Re-ask ${tries + 1}/2; exhaustion records FAILED, never DONE.`;
	}
	const reason = declared
		? (declaration?.[0] ?? "declared blocked")
		: "lane remains incomplete after two completion re-asks";
	const failed = run(
		process.execPath,
		[
			join(bin, "work.ts"),
			"fail",
			context.item,
			"--as",
			context.sid,
			"--note",
			reason,
		],
		{ cwd: wt },
	);
	if (!failed.ok)
		return `STOP-GATE: failed to record incomplete ${context.item}; control-plane intervention required.`;
	writeFileSync(
		marker,
		JSON.stringify({
			...context,
			tries,
			outcome: "FAILED",
			reason,
			decisionPending: true,
		}),
	);
	if (!recordDecision(reason, tries))
		return `STOP-GATE: ${context.item} is FAILED but its NEED_DECISION could not be recorded; restore the control plane.`;
	return null;
}
