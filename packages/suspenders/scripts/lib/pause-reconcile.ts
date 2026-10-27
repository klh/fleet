import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	openStore,
	projectIdentity,
	type GovernorStore,
} from "../../hooks/lib/govdb/govdb.ts";
import {
	pausedNativeBoundary,
	restartHash,
} from "../../hooks/lib/executors/claude-restart.ts";
import {
	captureManagedPauseEvidence,
	type IntentBirthEvidence,
} from "./intent-birth-reconcile.ts";
import { restartTreeHash } from "./restart-tree-snapshot.ts";
import { canonicalProjectRoot } from "../../hooks/lib/lanes/lane-registry.ts";

export type PauseBoundaryEvidence = IntentBirthEvidence & {
	stateVersion: number;
	stateTs: number;
	capsuleHash: string;
	logHash: string;
	treeHash: string;
	metadataRows: number;
};

/** CLI command-catalog notifications are metadata, not an inference turn.
 * Exact fields prevent a generic system frame hiding messages or controls. */
export function administrativeCommandsFrame(
	frame: Record<string, unknown>,
	session: string,
): boolean {
	if (
		frame.type !== "system" ||
		frame.subtype !== "commands_changed" ||
		frame.session_id !== session ||
		typeof frame.uuid !== "string" ||
		!/^[a-f0-9-]{36}$/.test(frame.uuid) ||
		Object.keys(frame).some(
			(key) =>
				!["type", "subtype", "commands", "uuid", "session_id"].includes(key),
		) ||
		!Array.isArray(frame.commands) ||
		frame.commands.length > 1024
	)
		return false;
	return frame.commands.every(
		(command) =>
			command &&
			typeof command === "object" &&
			!Array.isArray(command) &&
			typeof command.name === "string" &&
			Object.entries(command).every(([key, value]) => {
				if (["name", "description", "argumentHint"].includes(key))
					return typeof value === "string" && value.length <= 4096;
				if (key === "builtin") return typeof value === "boolean";
				return (
					key === "aliases" &&
					Array.isArray(value) &&
					value.length <= 64 &&
					value.every(
						(alias) => typeof alias === "string" && alias.length <= 256,
					)
				);
			}),
	);
}

/** Reconciliation is stricter than a normal restart: no native record may
 * follow the successful pause, including a fresh init of the same UUID. */
export function assertQuietNativePause(
	frames: Record<string, unknown>[],
	checkpoint: string,
	nativeSession: string,
): void {
	const pause = frames.findLastIndex(
		(frame) => frame.type === "fleet.claude.pause",
	);
	const init = frames.findLastIndex(
		(frame) => frame.type === "system" && frame.subtype === "init",
	);
	const result = frames
		.slice(0, pause)
		.findLast((frame) => frame.type === "result");
	if (
		!pausedNativeBoundary(frames, checkpoint) ||
		init < 0 ||
		init >= pause ||
		frames[init].session_id !== nativeSession ||
		result?.session_id !== nativeSession ||
		frames
			.slice(pause + 1)
			.some(
				(frame) =>
					!(
						frame.type === "fleet.claude.watcher" &&
						frame.state === "rearming" &&
						Object.keys(frame).every((key) =>
							["type", "sid", "state", "reason", "attempt"].includes(key),
						)
					) && !administrativeCommandsFrame(frame, nativeSession),
			)
	)
		throw Error("Exact quiet native UUID/result/pause boundary is not proven");
}

/** Read-only operator evidence. Existing claim/token, settings, process-start,
 * registered intent and Git checkpoint guards remain the shared authority. */
export function capturePauseBoundaryEvidence(
	root: string,
	item: string,
): PauseBoundaryEvidence {
	root = canonicalProjectRoot(root);
	const original = captureManagedPauseEvidence(root, item, "PAUSE_REQUESTED");
	const path = join(root, ".fleet", `lane-${original.sid}.log`);
	if (lstatSync(path).size > 128 * 1024 * 1024)
		throw Error("Native log exceeds evidence bound");
	const raw = readFileSync(path, "utf8");
	if (!raw.endsWith("\n")) throw Error("Native log is incomplete");
	const records = raw
		.trimEnd()
		.split("\n")
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return null;
			}
		});
	const pauseLine = records.findLastIndex(
		(frame) => frame?.type === "fleet.claude.pause",
	);
	// Launcher diagnostics may precede the conversation. Unknown bytes after
	// its pause cannot be silently discarded as evidence of quiescence.
	if (records.slice(pauseLine + 1).some((frame) => !frame))
		throw Error("Unknown records follow native pause");
	const frames = records.filter(
		(frame): frame is Record<string, unknown> => frame !== null,
	);
	assertQuietNativePause(frames, original.checkpoint, original.nativeSession);
	const store = openStore();
	try {
		const state = store
			.query("SELECT value,version,ts FROM facts WHERE key=?")
			.get(`lane.${original.sid}.state`) as {
			value: string;
			version: number;
			ts: number;
		} | null;
		const capsule = store
			.query("SELECT value FROM facts WHERE key=?")
			.get(`lane.${original.sid}.capsule`) as { value: string } | null;
		if (
			state?.value !== "PAUSE_REQUESTED" ||
			!capsule ||
			!Number.isSafeInteger(state.version)
		)
			throw Error("Pause state changed during evidence capture");
		return {
			...original,
			stateVersion: state.version,
			stateTs: state.ts,
			capsuleHash: restartHash(capsule.value),
			logHash: restartHash(raw),
			treeHash: restartTreeHash(original.worktree),
			metadataRows: frames
				.slice(
					frames.findLastIndex((frame) => frame.type === "fleet.claude.pause") +
						1,
				)
				.filter((frame) =>
					administrativeCommandsFrame(frame, original.nativeSession),
				).length,
		};
	} finally {
		store.close();
	}
}

/** No source-session impersonation: this records operator reconciliation,
 * never delivery, acknowledgement or new model progress. */
export function reconcilePausedBoundary(
	store: GovernorStore,
	expected: PauseBoundaryEvidence,
	capture: () => PauseBoundaryEvidence,
): void {
	store.transaction(() => {
		if (JSON.stringify(capture()) !== JSON.stringify(expected))
			throw Error("Pause reconciliation evidence changed");
		const changed = store
			.query(
				"UPDATE facts SET value='PAUSED',source='operator-pause-reconcile',version=version+1,ts=? WHERE key=? AND value='PAUSE_REQUESTED' AND version=? AND ts=? AND EXISTS (SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state='CLAIMED' AND updated_at=?)",
			)
			.run(
				Date.now(),
				`lane.${expected.sid}.state`,
				expected.stateVersion,
				expected.stateTs,
				expected.project,
				expected.item,
				expected.sid,
				expected.claimRevision,
			);
		// The real facts table has projection triggers; its affected count can
		// include their writes. The unique key and WHERE own the CAS, and the
		// exact postcondition confirms it inside the same transaction.
		const state = store
			.query("SELECT value,version,source FROM facts WHERE key=?")
			.get(`lane.${expected.sid}.state`) as {
			value: string;
			version: number;
			source: string;
		} | null;
		if (
			!Number.isSafeInteger(changed.changes) ||
			changed.changes < 1 ||
			state?.value !== "PAUSED" ||
			state.version !== expected.stateVersion + 1 ||
			state.source !== "operator-pause-reconcile"
		)
			throw Error("Pause reconciliation state/claim CAS changed");
		store.run(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,?)",
			Date.now(),
			"operator-pause-reconcile",
			"lane.pause.operator-reconciled",
			expected.item,
			JSON.stringify({
				project: expected.project,
				item: expected.item,
				sid: expected.sid,
				state: "OPERATOR_RECONCILED",
				evidenceHash: restartHash(JSON.stringify(expected)),
				checkpoint: expected.checkpoint,
				nativeSession: expected.nativeSession,
				oldBirth: expected.intent.birth,
				actualBirth: expected.newBirth,
				native: expected.native,
				claimRevision: expected.claimRevision,
				lastSemanticActivity: "native-success-result-before-managed-pause",
				metadataOnlySuffixRows: expected.metadataRows,
			}),
			expected.sid,
		);
	})();
}

/** Existing local OS operator authority; no --as identity is accepted. */
export function reconcilePause(
	root: string,
	item: string,
	path: string,
	apply: boolean,
): void {
	if (!apply) {
		const evidence = capturePauseBoundaryEvidence(root, item);
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(evidence, null, 2));
		} finally {
			closeSync(fd);
		}
		console.log(`${item} quiet pause evidence prepared; no records changed`);
		return;
	}
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size > 64 * 1024
	)
		throw Error("Pause evidence must be a regular 0600 file under64KiB");
	const expected = JSON.parse(
		readFileSync(path, "utf8"),
	) as PauseBoundaryEvidence;
	if (
		expected.version !== 1 ||
		expected.item !== item ||
		expected.project !== projectIdentity(root)
	)
		throw Error("Pause evidence scope mismatch");
	const store = openStore();
	try {
		reconcilePausedBoundary(store, expected, () =>
			capturePauseBoundaryEvidence(root, item),
		);
	} finally {
		store.close();
	}
	console.log(
		`${item} OPERATOR_RECONCILED to PAUSED; no delivery or acceptance claimed`,
	);
}
