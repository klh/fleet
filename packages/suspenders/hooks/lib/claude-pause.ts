import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run as gateRun } from "./run.ts";

/** Shared git proof for runtime and synchronous Stop; never opens a store. */
export function verifiedPauseCheckpoint(
	capsule: unknown,
	cwd: string,
): { checkpoint: string } | null {
	const checkpoint =
		capsule && typeof capsule === "object"
			? (capsule as { checkpoint?: unknown }).checkpoint
			: null;
	if (typeof checkpoint !== "string" || !/^[a-f0-9]{40}$/.test(checkpoint))
		return null;
	if (!gateRun("git", ["cat-file", "-e", `${checkpoint}^{commit}`], { cwd }).ok)
		return null;
	if (
		!gateRun("git", ["merge-base", "--is-ancestor", checkpoint, "HEAD"], {
			cwd,
		}).ok
	)
		return null;
	return { checkpoint };
}

/**
 * W1124.30 bounded operator-pause contract — ONE deterministic text shared by
 * the managed-runtime pause prompt and the Stop-gate feedback, so a pause turn
 * never re-derives its own rules: dirty edits are the expected pause state,
 * gates/push/completion detours are forbidden (they are what burned minutes in
 * the W1052/W1094/W1131/W1196 pause transcripts), and the checkpoint proof
 * stays a real ancestor sha verified in code (verifiedPauseCheckpoint), never
 * a model self-claim.
 */
export function boundedPauseContract(sid: string): string {
	return (
		"PAUSE TURN IS BOUNDED — end the turn as soon as the checkpoint is banked. " +
		"Dirty uncommitted edits are the expected pause state and stay exactly as-is. " +
		"Do NOT run qlty fmt, qlty check or tests, do NOT push, " +
		"do NOT run work done/release/retry, and do NOT rewrite .fleet/lane-context.json, " +
		"the claim token or per-lane settings — claim, token and context baseline survive the pause unchanged. " +
		"Committing is optional (gate-free, only an already-atomic boundary); otherwise leave the edits dirty. " +
		`Bank the continuation: coord capsule set --as ${sid} --checkpoint=<current full HEAD sha> --done=<truthful progress> --next=<continuation>, ` +
		`then coord paused --as ${sid} --sha <same full sha>. ` +
		"The checkpoint must be a real existing ancestor of HEAD — never an invented sha or fabricated progress."
	);
}

/** A pause is a lifecycle boundary, not a completed/failed work claim. */
export function claudeStopPause(
	store: { query(sql: string): { get(...args: unknown[]): unknown } },
	sid: string,
	cwd: string,
): "paused" | string | null {
	const state = (
		store
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`lane.${sid}.state`) as { value?: unknown } | null
	)?.value;
	if (state === "RESUME_READY")
		return `STOP-GATE: resume reconciliation is pending for ${sid}. Preserve your work claim. Read the resume_ready event and continuation capsule, reconcile the requested revision safely without discarding edits, run the required checks, then coord resumed --as ${sid}. Do not finish or fail the work item merely to resume.`;
	if (state !== "PAUSED" && state !== "PAUSE_REQUESTED") return null;
	let capsule: unknown;
	try {
		const raw = (
			store
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${sid}.capsule`) as { value?: unknown } | null
		)?.value;
		capsule = typeof raw === "string" ? JSON.parse(raw) : null;
	} catch {
		capsule = null;
	}
	if (state === "PAUSED" && verifiedPauseCheckpoint(capsule, cwd))
		return "paused";
	return `STOP-GATE: pause checkpoint is not verified for ${sid}. ${boundedPauseContract(sid)} Do not finish or fail the work item merely to pause.`;
}

const run = promisify(execFile);
const coord = new URL("../bin/coord.ts", import.meta.url).pathname;
const read = async (sid: string, args: string[]) =>
	(
		await run(process.execPath, [coord, ...args, "--as", sid], {
			timeout: 10_000,
			maxBuffer: 32_768,
		})
	).stdout;

export async function claudeLaneState(sid: string): Promise<string | null> {
	try {
		return (
			/^([A-Z_]+) \(v\d+\)/.exec(
				await read(sid, ["fact", "get", `lane.${sid}.state`]),
			)?.[1] ?? null
		);
	} catch {
		return null;
	}
}

/** Read the canonical pause proof through the supported CLI, never its DB. */
export async function claudePauseProof(
	sid: string,
	expectedState: "PAUSED" | "RESUME_READY" = "PAUSED",
): Promise<{ checkpoint: string } | null> {
	try {
		if ((await claudeLaneState(sid)) !== expectedState) return null;
		const capsule = JSON.parse(await read(sid, ["capsule", "get"])) as {
			checkpoint?: unknown;
		};
		return verifiedPauseCheckpoint(capsule, process.cwd());
	} catch {
		return null;
	}
}

export function claudeWakeControl(
	text: string,
): "pause_requested" | "resume_ready" | null {
	const kind = /^Fleet direct event #\d+ \(([^)]+)\)/.exec(text)?.[1];
	return kind === "pause_requested" || kind === "resume_ready" ? kind : null;
}

export function claudePausePrompt(sid: string, text: string): string {
	return (
		`${text}\nFLEET_MANAGED_PAUSE: ${boundedPauseContract(sid)} ` +
		"End this turn after the checkpoint. Fleet keeps this native session waiting; do not run a polling loop or continue work until resume_ready."
	);
}

export function claudeResumePrompt(sid: string, text: string): string {
	return `${text}\nFLEET_MANAGED_RESUME: Read the resume_ready event and your continuation capsule. Reconcile the requested revision safely without discarding edits, run the required checks, then coord resumed --as ${sid}. Only then continue your work. A delivered message is not acceptance.`;
}
