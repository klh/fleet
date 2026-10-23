import {
	lstatSync,
	openSync,
	closeSync,
	writeFileSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	openStore,
	projectIdentity,
	type GovernorStore,
} from "../../hooks/lib/govdb.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
} from "../../hooks/lib/lane-registry.ts";
import {
	laneProcessIdentity,
	type LaneRef,
} from "../../hooks/lib/lane-liveness.ts";
import { pausedNativeBoundary } from "../../hooks/lib/claude-restart.ts";
import {
	claudeRestartAuthority,
	children,
	readFrames,
} from "./claude-restart-operation.ts";
import {
	launchIntent,
	processBirth,
	inspectLaunchIntent,
	type LaunchIntent,
} from "./launch-fencing.ts";
import { obsoleteProcessStart } from "./process-birth.ts";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
export type IntentBirthEvidence = {
	version: 1;
	project: string;
	item: string;
	sid: string;
	worktree: string;
	intent: LaunchIntent;
	registryHash: string;
	contextHash: string;
	settingsHash: string;
	claimRevision: number;
	checkpoint: string;
	nativeSession: string;
	newBirth: string;
	native: { pid: number; birth: string };
};

export function intentSettingsHash(path: string): string {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size > 1024 * 1024
	)
		throw Error("Exact native settings must be a regular bounded 0600 file");
	const data = readFileSync(path, "utf8");
	JSON.parse(data);
	return hash(data);
}

/** Operator-only repair evidence, derived from the same current authority and
 * paused native boundary as restart. No equality fallback blesses old births. */
export function captureIntentBirthEvidence(
	root: string,
	item: string,
): IntentBirthEvidence {
	root = canonicalProjectRoot(root);
	const lane = loadLaneRegistry<LaneRef>(root).find((row) => row.item === item);
	if (!lane?.worktree || !lane.pid || laneProcessIdentity(lane) !== true)
		throw Error("Reconciliation requires exact live registered wrapper");
	const worktree = realpathSync(lane.worktree);
	const { claim, checkpoint } = claudeRestartAuthority(
		lane.sid,
		item,
		worktree,
	);
	const store = openStore();
	let intent: LaunchIntent | null;
	try {
		intent = launchIntent(store, claim.project, item);
	} finally {
		store.close();
	}
	if (
		!intent ||
		intent.sid !== lane.sid ||
		intent.pid !== lane.pid ||
		intent.state !== "REGISTERED" ||
		!intent.birth
	)
		throw Error("Reconciliation intent binding mismatch");
	const start = obsoleteProcessStart(intent.birth);
	const wrapper = processBirth(lane.pid) || null;
	if (
		!start ||
		!wrapper?.birth.startsWith("darwin:") ||
		!wrapper.birth.endsWith(`:${start}`)
	)
		throw Error("Original microsecond process start is not proven");
	if (inspectLaunchIntent({ ...intent, birth: wrapper.birth }) !== "alive")
		throw Error("Original executable identity is not proven");
	const nativePids = children(lane.pid);
	const native =
		(nativePids.length === 1 ? processBirth(nativePids[0]) : null) || null;
	const settings = join(root, ".fleet", `lane-settings-${lane.sid}.json`);
	if (!native?.command.includes(settings))
		throw Error("Exact native settings/child identity is not proven");
	const frames = readFrames(join(root, ".fleet", `lane-${lane.sid}.log`));
	if (!pausedNativeBoundary(frames, checkpoint))
		throw Error("Native is active or pause boundary is not proven");
	const session = frames.findLast(
		(frame) => frame.type === "system" && frame.subtype === "init",
	)?.session_id;
	if (typeof session !== "string" || !/^[a-f0-9-]{36}$/.test(session))
		throw Error("Native session UUID is not proven");
	return {
		version: 1,
		project: projectIdentity(root),
		item,
		sid: lane.sid,
		worktree,
		intent,
		registryHash: hash(JSON.stringify(lane)),
		contextHash: hash(
			readFileSync(join(worktree, ".fleet", "lane-context.json"), "utf8"),
		),
		settingsHash: intentSettingsHash(settings),
		claimRevision: claim.updated_at,
		checkpoint,
		nativeSession: session,
		newBirth: wrapper.birth,
		native: { pid: nativePids[0], birth: native.birth },
	};
}

/** One fenced row update plus immutable event. Revalidation stays inside the
 * transaction; a competing claim or intent cannot be overwritten. */
export function reconcileIntentBirth(
	store: GovernorStore,
	expected: IntentBirthEvidence,
	capture: () => IntentBirthEvidence,
): void {
	store.transaction(() => {
		const current = capture();
		if (JSON.stringify(current) !== JSON.stringify(expected))
			throw Error("Reconciliation evidence changed");
		const old = expected.intent;
		const changed = store
			.query(
				"UPDATE lane_launch_intents SET birth=? WHERE project=? AND item=? AND sid=? AND nonce=? AND revision=? AND state='REGISTERED' AND pid=? AND birth=? AND EXISTS (SELECT 1 FROM work_items w WHERE w.project=? AND w.id=? AND w.owner_sid=? AND w.state='CLAIMED' AND w.updated_at=?)",
			)
			.run(
				expected.newBirth,
				old.project,
				old.item,
				old.sid,
				old.nonce,
				old.revision,
				old.pid,
				old.birth,
				old.project,
				old.item,
				old.sid,
				expected.claimRevision,
			);
		if (changed.changes !== 1)
			throw Error("Reconciliation intent/claim CAS changed");
		store.run(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,?,?,?,?,?)",
			Date.now(),
			"operator-intent-reconcile",
			"dispatch.intent.birth-reconciled",
			expected.item,
			JSON.stringify({
				project: expected.project,
				item: expected.item,
				sid: expected.sid,
				evidenceHash: hash(JSON.stringify(expected)),
				oldBirth: old.birth,
				newBirth: expected.newBirth,
				pid: old.pid,
				checkpoint: expected.checkpoint,
				claimRevision: expected.claimRevision,
			}),
			expected.sid,
		);
	})();
}

/** CLI authority is the local OS operator, not a spoofable --as identity. */
export function intentBirthReconcile(
	root: string,
	item: string,
	path: string,
	apply: boolean,
): void {
	if (!apply) {
		const evidence = captureIntentBirthEvidence(root, item);
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(evidence, null, 2));
		} finally {
			closeSync(fd);
		}
		console.log(`${item} reconciliation evidence prepared; no records changed`);
		return;
	}
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size > 64 * 1024
	)
		throw Error(
			"Reconciliation evidence must be a regular 0600 file under 64KiB",
		);
	const expected = JSON.parse(
		readFileSync(path, "utf8"),
	) as IntentBirthEvidence;
	if (
		expected.version !== 1 ||
		expected.item !== item ||
		expected.project !== projectIdentity(root)
	)
		throw Error("Reconciliation evidence scope mismatch");
	const store = openStore();
	try {
		reconcileIntentBirth(store, expected, () =>
			captureIntentBirthEvidence(root, item),
		);
	} finally {
		store.close();
	}
	console.log(
		`${item} intent birth reconciled; claim, process and worktree preserved`,
	);
}
