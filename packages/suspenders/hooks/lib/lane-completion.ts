import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { run } from "./run.ts";
import { openGovernorDb } from "./govdb.ts";
import { projectIdentity } from "./govdb-project.ts";
import { itemCapsuleKey } from "./capsule-fence.ts";
import type { HookInput } from "./hookio.ts";
import { FileLockUnavailable, withFileLock } from "./file-lock.ts";
import { completionTurn, writeCompletionTurn } from "./lane-completion-turn.ts";

type Context = {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
	worktree?: string;
};

// ---- W502: checkpoint-parked continuation (lifted: omc persistent-mode) ----
// omc's persistent-mode.mjs never lets a stop end a session with work in
// flight. Ours is ONE offer per episode, bounded by the loop guard
// stop_hook_active (true on every stop after the first of an episode), after
// which the existing 2-re-ask → FAILED bound runs unchanged. W577: parking is
// EVIDENCE, not declaration — the ONLY capsule that may park a stop is the
// item-authoritative one (the project-scoped itemCapsuleKey, source column =
// the owner sid)
// whose checkpoint is a real commit strictly ahead of the lane's dispatch
// baseline and reachable from HEAD, banked fresh (row ts). A legacy
// lane-scoped, other-item, other-owner, baseline-equal or stale capsule must
// not bypass the bounded continuation. Any probe failure degrades to the
// ordinary re-ask path (omc's allow-on-error).
const CAPSULE_SHA = /^[a-f0-9]{40}$/i;
const CAPSULE_MAX_AGE_MS = 24 * 86_400_000;
const CAPSULE_FUTURE_SKEW_MS = 5 * 60_000;

/** Bounded text for the continuation program (context, not an essay). */
function clip(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** The item-authoritative capsule, parsed: the project-scoped itemCapsuleKey
 * (W687), written by the owner sid (facts source column), with a row ts
 * proving the evidence is fresh. Anything else — legacy lane-scoped,
 * other-owner, stale — is null. */
export function capsuleEvidence(
	item: string,
	sid: string,
	project: string,
): { checkpoint?: unknown; done?: unknown; next?: unknown } | null {
	let row: { value?: unknown; source?: unknown; ts?: unknown } | undefined;
	try {
		row = openGovernorDb()
			.query("SELECT value, source, ts FROM facts WHERE key = ?")
			.get(itemCapsuleKey(project, item));
	} catch {
		return null;
	}
	const fresh =
		typeof row?.ts === "number" &&
		row.ts <= Date.now() + CAPSULE_FUTURE_SKEW_MS &&
		Date.now() - row.ts <= CAPSULE_MAX_AGE_MS;
	// owner association rides the facts row's source column, never payload text
	if (!row || !fresh || row.source !== sid || typeof row.value !== "string")
		return null;
	try {
		return JSON.parse(row.value) as {
			checkpoint?: unknown;
			done?: unknown;
			next?: unknown;
		};
	} catch {
		return null;
	}
}

/** The one capsule checkpoint allowed to park: fresh, owner-banked on the
 * item key, and git-proven strictly-new progress over the dispatch baseline. */
function parkedCheckpoint(wt: string, context: Context): string | null {
	const cap = capsuleEvidence(context.item, context.sid, projectIdentity(wt));
	if (!cap) return null;
	const sha =
		typeof cap.checkpoint === "string" && CAPSULE_SHA.test(cap.checkpoint)
			? cap.checkpoint
			: null;
	if (
		!sha ||
		!run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: wt }).ok
	)
		return null;
	// baseline proof: the checkpoint must strictly advance the dispatch
	// baseline — a park at the baseline is a no-op wearing a checkpoint
	const base = context.baseline;
	if (!base || !CAPSULE_SHA.test(base) || base === sha) return null;
	if (!run("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: wt }).ok)
		return null;
	if (!run("git", ["merge-base", "--is-ancestor", base, sha], { cwd: wt }).ok)
		return null;
	return run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: wt })
		.ok
		? sha
		: null;
}

/** The lane's activation context: .fleet/lane-context.json in this worktree,
 * else the main checkout's .fleet/lanes.json index matched by worktree. */
export function laneContext(wt: string): Context | undefined {
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

/** W516: the lane-context resolution shared by laneCompletion and the
 *  stop-gate turn-boundary drain — one resolution, two spellings. */
export const resolveLaneContext = laneContext;

/** Claimed lane completion is separate from formatter/knowledge loop guards.
 * W1124.13: the whole read/compute/write decision runs under the ONE shared
 * cross-process file lock, so concurrent duplicate Stops cannot double-spend
 * an attempt or tear the completion marker. */
export function laneCompletion(
	hook: HookInput & { last_assistant_message?: string },
): string | null {
	if (!hook.cwd || !existsSync(hook.cwd)) return null;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: hook.cwd });
	if (!top.ok) return null;
	try {
		return withFileLock(
			join(top.out.trim(), ".fleet/completion-attempt.json"),
			() => laneCompletionLocked(hook),
		);
	} catch (error) {
		if (!(error instanceof FileLockUnavailable)) throw error;
		return "STOP-GATE: continuation_lock_unavailable; no attempt consumed. Inspect the lock owner before recovery.";
	}
}

function laneCompletionLocked(
	hook: HookInput & { last_assistant_message?: string },
): string | null {
	const cwd = hook.cwd;
	if (!cwd || !existsSync(cwd)) return null;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) return null;
	const wt = top.out.trim();
	const context = laneContext(wt);
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
		priority?: number;
		title?: string;
		description?: string;
		capsule?: { done?: unknown; next?: unknown } | null;
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
				ts: Date.now(),
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
	// W642 terminal-phase short-circuit (research-oh-my-claudecode §1.7): an
	// activation that already concluded — parked on a capsule or failed with
	// its decision recorded — stays concluded. Re-evaluating later would
	// un-park or re-fail on stale evidence; the claim belongs to the reaper.
	if (previous.outcome === "PARKED" || previous.outcome === "FAILED")
		return null;
	// W1124.13: the logical assistant turn key. Terminal/ownership verification
	// above deliberately outranks a cached reply — newly saved work done and
	// ownership transfer override a same-turn refusal replay.
	const turn = completionTurn(hook, context);
	if (previous.turnId === turn.id && Object.hasOwn(previous, "reply"))
		return typeof previous.reply === "string" ? previous.reply : null;
	if (!turn.usable) {
		// No new productive assistant turn (API-error/empty frame, missing or
		// oversize transcript): a typed operational diagnostic published once
		// per logical turn — never a completion-disobedience attempt. An
		// unpublished notice leaves the cached reply unwritten so duplicate
		// Stops keep the durable publication retry alive without spinning.
		let sent = previous.transportNoticeSent === true;
		if (!sent)
			sent = run(
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
					`${context.item}: lane_turn_no_output (${turn.reason}); no completion attempt consumed. Inspect route/stream and transcript delivery.`,
				],
				{ cwd: wt },
			).ok;
		writeCompletionTurn(
			marker,
			{
				...previous,
				...context,
				ts: Date.now(),
				outcome: "TRANSPORT_BLOCKED",
				transportNoticeSent: sent,
				diagnostic: turn.reason,
			},
			turn,
			sent ? null : undefined,
		);
		return null;
	}
	// W642 reinforcement classes (research-oh-my-claudecode §1.7): the
	// continuation budget was a hardcoded 2; classes scale it by item
	// priority (>=2 heavy / 1 medium / else light; SUSPENDERS_REINFORCEMENT_CLASS
	// overrides) and a stale TTL resets an ENGAGED lane's count — a stop that
	// comes >TTL after quiet productive work is a new episode, not budget
	// burn. Global staleness clamps at 2h.
	const classes = {
		light: { max: 3, ttl: 5 * 60_000 },
		medium: { max: 5, ttl: 15 * 60_000 },
		heavy: { max: 10, ttl: 30 * 60_000 },
	};
	const envClass = process.env.SUSPENDERS_REINFORCEMENT_CLASS;
	const cls =
		envClass === "light" || envClass === "medium" || envClass === "heavy"
			? envClass
			: (row.priority ?? 0) >= 2
				? "heavy"
				: (row.priority ?? 0) === 1
					? "medium"
					: "light";
	const budget = classes[cls];
	const stale =
		typeof previous.ts === "number" &&
		Date.now() - previous.ts > Math.min(budget.ttl, 2 * 3_600_000);
	const dir = join(wt, ".fleet");
	mkdirSync(dir, { recursive: true });
	const head = run("git", ["rev-parse", "HEAD"], { cwd: wt });
	const porcelain = run("git", ["status", "--porcelain"], { cwd: wt });
	const headSha = head.ok ? head.out.trim() : "<commit>";
	const dirty = porcelain.ok && porcelain.out.trim().length > 0;
	const cap = row.capsule;
	const remains = clip(
		(typeof cap?.next === "string" && cap.next.trim()) ||
			(typeof row.description === "string" && row.description.trim()) ||
			(typeof row.title === "string" && row.title.trim()) ||
			context.item,
		240,
	);
	const program = [
		`WHAT REMAINS: ${remains}`,
		"CLOSE EXACTLY:",
		...(dirty
			? [`  git add -A && git commit -m "${context.item}: checkpoint"`]
			: []),
		`  work done ${context.item} --sha ${headSha} --summary "<40+ char completion paragraph>"`,
		`CHECKPOINT fallback: coord capsule set --as ${context.sid} --item ${context.item} --checkpoint=${headSha} --done=<progress> --next=<step>; a git-reachable checkpoint ahead of the dispatch baseline parks the item CLAIMED/resumable, then declare BLOCKED ${context.item}: <specific reason> (or NO_OP ${context.item}: <specific reason>).`,
	].join("\n");
	const sigEnvSource = {
		...process.env,
		GIT_INDEX_FILE: join(dir, "sig-index"),
	};
	const staged = run(
		"git",
		["add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude).fleet"],
		{ cwd: wt, env: sigEnvSource },
	);
	const tree = staged.ok
		? run("git", ["write-tree"], { cwd: wt, env: sigEnvSource })
		: null;
	const sig = staged.ok && tree?.ok ? `${headSha}:${tree.out.trim()}` : null;
	const prevSig = typeof previous.sig === "string" ? previous.sig : undefined;
	const stall =
		stale || sig === null || prevSig !== sig
			? 0
			: typeof previous.stall === "number" && previous.stall >= 0
				? previous.stall + 1
				: 1;
	const tries = stale
		? 0
		: typeof previous.tries === "number" &&
				Number.isInteger(previous.tries) &&
				previous.tries >= 0
			? previous.tries
			: 0;
	const declaration = /^(NO_OP|BLOCKED)\s+(\S+):\s*(.{10,})$/m.exec(
		hook.last_assistant_message ?? "",
	);
	const declared = declaration?.[2] === context.item;
	// W502: checkpoint park + the ONE bounded continuation offer. The offer
	// runs only on the episode's first stop (loop guard stop_hook_active);
	// it burns re-ask slot 1, so the total stop bound is unchanged (offer →
	// Re-ask 2/2 → FAILED). A declared BLOCKED/NO_OP skips both — explicit
	// failure intent beats an implicit park.
	if (!declared) {
		const parked = parkedCheckpoint(wt, context);
		if (parked) {
			writeFileSync(
				marker,
				JSON.stringify({
					...context,
					tries,
					ts: Date.now(),
					outcome: "PARKED",
					checkpoint: parked,
				}),
			);
			return null;
		}
		if (tries < budget.max && hook.stop_hook_active !== true) {
			const reply = `STOP-GATE: ${context.item} remains ${row.state} by ${context.sid}. One bounded continuation before re-asks resume — DO NOT re-read the brief, re-reading is not progress. Edits and commits are progress, not completion.\n${program}`;
			writeCompletionTurn(
				marker,
				{ ...context, tries: tries + 1, sig, stall, ts: Date.now() },
				turn,
				reply,
			);
			return reply;
		}
	}
	if (tries < budget.max && !declared) {
		const stallNote =
			stall >= 2
				? ` STALL: ${stall} consecutive continuations changed nothing in this worktree — reads are not progress; execute the program below NOW.`
				: "";
		const reply = `STOP-GATE: ${context.item} remains ${row.state} by ${context.sid}. Re-ask ${tries + 1}/${budget.max}; exhaustion records FAILED, never DONE.${stallNote} Edits and commits are progress, not completion.\n${program}`;
		writeCompletionTurn(
			marker,
			{ ...context, tries: tries + 1, sig, stall, ts: Date.now() },
			turn,
			reply,
		);
		return reply;
	}
	const reason = declared
		? (declaration?.[0] ?? "declared blocked")
		: `lane remains incomplete after the continuation budget (${cls}, max ${budget.max})`;
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
			ts: Date.now(),
			outcome: "FAILED",
			reason,
			decisionPending: true,
		}),
	);
	if (!recordDecision(reason, tries))
		return `STOP-GATE: ${context.item} is FAILED but its NEED_DECISION could not be recorded; restore the control plane.`;
	return null;
}
