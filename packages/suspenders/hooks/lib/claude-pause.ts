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
	return `STOP-GATE: pause checkpoint is not verified for ${sid}. Preserve your work claim. Commit safe progress, bank coord capsule set --as ${sid} --checkpoint=<real-full-ancestor-sha> --done=<progress> --next=<continuation>, then coord paused --as ${sid} --sha <same-full-sha>. Do not finish or fail the work item merely to pause.`;
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
	return `${text}\nFLEET_MANAGED_PAUSE: Stop normal work at the smallest safe atomic boundary. Commit safe progress, then bank a continuation with coord capsule set --as ${sid} --checkpoint=<real-full-sha> --done=<progress> --next=<continuation>, then coord paused --as ${sid} --sha <same-full-sha>. Do not claim PAUSED without that canonical proof. End this turn after the checkpoint. Fleet will keep this native session waiting; do not run a polling loop or continue work until resume_ready.`;
}

export function claudeResumePrompt(sid: string, text: string): string {
	return `${text}\nFLEET_MANAGED_RESUME: Read the resume_ready event and your continuation capsule. Reconcile the requested revision safely without discarding edits, run the required checks, then coord resumed --as ${sid}. Only then continue your work. A delivered message is not acceptance.`;
}
