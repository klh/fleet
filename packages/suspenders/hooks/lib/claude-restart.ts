import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./file-lock.ts";

export type RestartIdentity = { pid: number; birth: string };
export type ClaudeRestartSnapshot = {
	version: 1;
	id: string;
	sid: string;
	item: string;
	worktree: string;
	checkpoint: string;
	nativeSession: string;
	nativeBin: string;
	transcript: string;
	transcriptHash: string;
	settings: string;
	settingsHash: string;
	sourceSettings: string;
	sourceSettingsHash: string;
	settingsDelta: string[];
	runtime: string;
	runtimeHash: string;
	claimRevision: number;
	contextHash: string;
	treeHash: string;
	oldWrapper: RestartIdentity;
	oldNative: RestartIdentity;
};
export type ClaudeRestartJournal = {
	snapshot: ClaudeRestartSnapshot;
	phase:
		| "prepared"
		| "retiring"
		| "retired"
		| "starting"
		| "started"
		| "verified";
	newWrapper?: RestartIdentity;
};
export type RestartDependencies = {
	/** Rechecks canonical PAUSED, Git/capsule, exact claim, settings/key and zero scoped inference. */
	validate: (snapshot: ClaudeRestartSnapshot) => Promise<void>;
	identity: (pid: number) => RestartIdentity | false | null;
	retire: (identity: RestartIdentity) => Promise<void>;
	start: (
		snapshot: ClaudeRestartSnapshot,
		journal: string,
	) => Promise<RestartIdentity>;
	register: (
		snapshot: ClaudeRestartSnapshot,
		identity: RestartIdentity,
	) => Promise<void>;
};

export const restartHash = (data: string | Buffer): string =>
	createHash("sha256").update(data).digest("hex");

export function privateJson<T>(path: string): T {
	if ((statSync(path).mode & 0o777) !== 0o600)
		throw new Error("Restart evidence must have mode 0600");
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function save(path: string, value: ClaudeRestartJournal): void {
	const temporary = `${path}.${process.pid}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}

/** A durable starting phase is uncertainty after a crash, NEVER permission
 * to launch a duplicate child. Recovery must first reconcile that incarnation. */
export async function checkpointedClaudeRestart(
	path: string,
	snapshot: ClaudeRestartSnapshot,
	deps: RestartDependencies,
): Promise<ClaudeRestartJournal> {
	const journal = withFileLock(path, () => {
		if (existsSync(path)) {
			const prior = privateJson<ClaudeRestartJournal>(path);
			if (JSON.stringify(prior.snapshot) !== JSON.stringify(snapshot))
				throw new Error("Restart snapshot changed");
			if (prior.phase !== "prepared" && prior.phase !== "retired")
				throw new Error(`Restart ${prior.phase}; reconcile before retry`);
			return prior;
		}
		const next: ClaudeRestartJournal = { snapshot, phase: "prepared" };
		save(path, next);
		return next;
	});
	await deps.validate(snapshot);
	if (journal.phase === "prepared") {
		for (const expected of [snapshot.oldWrapper, snapshot.oldNative]) {
			const actual = deps.identity(expected.pid);
			if (!actual || actual.birth !== expected.birth)
				throw new Error("Old managed process identity changed or unknown");
		}
		// Reserve retirement before signalling. Another invoker cannot signal
		// or launch while this operation is in progress.
		withFileLock(path, () => {
			if (privateJson<ClaudeRestartJournal>(path).phase !== "prepared")
				throw new Error("Restart already owned by another operation");
			journal.phase = "retiring";
			save(path, journal);
		});
		await deps.retire(snapshot.oldWrapper);
		if (
			deps.identity(snapshot.oldWrapper.pid) !== false ||
			deps.identity(snapshot.oldNative.pid) !== false
		)
			throw new Error("Old managed processes have not both exited");
		journal.phase = "retired";
		save(path, journal);
	}
	await deps.validate(snapshot);
	if (
		deps.identity(snapshot.oldWrapper.pid) !== false ||
		deps.identity(snapshot.oldNative.pid) !== false
	)
		throw new Error("Old incarnation is not proven absent");
	withFileLock(path, () => {
		if (privateJson<ClaudeRestartJournal>(path).phase !== "retired")
			throw new Error("Restart already owned by another operation");
		journal.phase = "starting";
		save(path, journal);
	});
	const identity = await deps.start(snapshot, path);
	journal.newWrapper = identity;
	save(path, journal);
	await deps.register(snapshot, identity);
	journal.phase = "started";
	save(path, journal);
	return journal;
}

/** Bootstrap waits silently in canonical PAUSED; the normal typed resume
 * flow supplies the first input to the resumed native conversation. */
export function restartBootstrap(
	path: string,
	sid: string,
	args: string[],
): ClaudeRestartSnapshot {
	const { snapshot, phase } = privateJson<ClaudeRestartJournal>(path);
	if (phase !== "starting" && phase !== "started")
		throw new Error("Restart is not starting");
	if (snapshot.sid !== sid || snapshot.worktree !== process.cwd())
		throw new Error("Restart lane binding mismatch");
	if (restartHash(readFileSync(snapshot.runtime)) !== snapshot.runtimeHash)
		throw new Error("Restart runtime generation changed");
	if (
		args.indexOf("--resume") < 0 ||
		!/^[a-f0-9-]{36}$/.test(snapshot.nativeSession) ||
		args[args.indexOf("--resume") + 1] !== snapshot.nativeSession ||
		args.includes("--fork-session")
	)
		throw new Error("Restart must continue the exact native session");
	if (
		args.indexOf("--settings") < 0 ||
		args[args.indexOf("--settings") + 1] !== snapshot.settings ||
		restartHash(readFileSync(snapshot.settings)) !== snapshot.settingsHash
	)
		throw new Error("Restart settings changed");
	return snapshot;
}

export const restartJournalPath = (worktree: string): string =>
	join(worktree, ".fleet", "claude-restart.json");

export function pausedNativeBoundary(
	frames: Array<Record<string, unknown>>,
	checkpoint: string,
): boolean {
	const index = frames.findLastIndex(
		(frame) => frame.type === "fleet.claude.pause",
	);
	const pause = frames[index];
	const result = frames
		.slice(0, index)
		.findLast((frame) => frame.type === "result");
	return (
		index >= 0 &&
		pause.state === "paused" &&
		pause.checkpoint === checkpoint &&
		result?.subtype === "success" &&
		result.is_error !== true &&
		!frames
			.slice(index + 1)
			.some((frame) =>
				["assistant", "user", "result", "control_response"].includes(
					String(frame.type),
				),
			)
	);
}

/** A started wrapper is not accepted delivery. Verification needs the new
 * runtime boundary, exact native UUID, actual interrupt and subsequent tool. */
export function restartContinuationProof(
	journal: ClaudeRestartJournal,
	frames: Array<Record<string, unknown>>,
): number | null {
	const start = frames.findIndex(
		(frame) =>
			frame.type === "fleet.claude.restart" &&
			frame.state === "waiting-paused" &&
			frame.id === journal.snapshot.id,
	);
	if (start < 0) return null;
	const current = frames.slice(start + 1);
	if (
		current.find((frame) => frame.type === "system" && frame.subtype === "init")
			?.session_id !== journal.snapshot.nativeSession
	)
		return null;
	const delivery = current.findIndex(
		(frame) =>
			frame.type === "fleet.claude.delivery" &&
			frame.state === "interrupted-and-injected" &&
			/^\d+$/.test(String(frame.event)),
	);
	if (delivery < 0) return null;
	const worked = current
		.slice(delivery + 1)
		.some(
			(frame) =>
				frame.type === "assistant" &&
				Array.isArray(
					(frame.message as { content?: unknown[] } | undefined)?.content,
				) &&
				(frame.message as { content: Array<{ type?: string }> }).content.some(
					(block) => block.type === "tool_use",
				),
		);
	return worked ? Number(current[delivery].event) : null;
}
