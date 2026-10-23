import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { openStore } from "../../hooks/lib/govdb.ts";
import { projectIdentity } from "../../hooks/lib/govdb-project.ts";
import { verifiedPauseCheckpoint } from "../../hooks/lib/claude-pause.ts";
import {
	checkpointedClaudeRestart,
	privateJson,
	restartHash,
	restartTranscriptMatches,
	retiredRestartSnapshot,
	restartJournalPath,
	restartContinuationProof,
	pausedNativeBoundary,
	validateRestartBoundary,
	type ClaudeRestartSnapshot,
	type ClaudeRestartJournal,
	type RestartIdentity,
} from "../../hooks/lib/claude-restart.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
	repairLaneRegistryPid,
	registerMissingRestartLane,
} from "../../hooks/lib/lane-registry.ts";
import { registryWorktrees } from "../../hooks/lib/worktree-lookup.ts";
import {
	laneProcessIdentity,
	type LaneRef,
} from "../../hooks/lib/lane-liveness.ts";
import { processBirth, launchIntent } from "./launch-fencing.ts";
import { adminKey, BUCKLE_FRONT } from "./lane-auth.ts";
import { adapterForExact } from "../../hooks/lib/executors/registry.ts";
import { materializeRestartSettings } from "./claude-restart-settings.ts";
import { readLaneContextFile } from "../../hooks/lib/lane-context.ts";
import { claimTokenVerdict } from "../../hooks/lib/work-fence.ts";

const identity = (pid: number): RestartIdentity | false | null => {
	const found = processBirth(pid);
	return found && { pid, birth: found.birth };
};
const sameIdentity = (expected: RestartIdentity): boolean => {
	const found = identity(expected.pid);
	return !!found && found.birth === expected.birth;
};
function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error("Restart Git evidence unavailable");
	return result.stdout.toString();
}
function treeHash(cwd: string): string {
	const untracked = git(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
		.split("\0")
		.filter(
			(name) =>
				name &&
				!name.startsWith(".fleet/") &&
				!name.includes("node_modules") &&
				name !== ".klh-brief.md",
		);
	return restartHash(
		JSON.stringify([
			git(cwd, ["rev-parse", "HEAD"]).trim(),
			git(cwd, ["diff", "--binary", "HEAD"]),
			...untracked
				.sort()
				.map((name) => [name, restartHash(readFileSync(join(cwd, name)))]),
		]),
	);
}
type Claim = {
	owner_sid: string;
	state: string;
	updated_at: number;
	project: string;
	claim_token_hash: string | null;
};
export function claudeRestartAuthority(
	sid: string,
	item: string,
	cwd: string,
): { claim: Claim; checkpoint: string } {
	const context = readLaneContextFile(cwd);
	if (context?.sid !== sid || context.item !== item)
		throw new Error("Restart worktree claim context mismatch");
	const store = openStore();
	try {
		const claim = store
			.query(
				"SELECT owner_sid,state,updated_at,project,claim_token_hash FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state='CLAIMED'",
			)
			.get(projectIdentity(cwd), item, sid) as Claim | null;
		if (!claim)
			throw new Error("Restart requires the current exact CLAIMED owner");
		const token = (context as { claimToken?: string }).claimToken;
		if (!claim.claim_token_hash || !claimTokenVerdict(claim, token).ok)
			throw new Error("Restart current claim token is not proven");
		const fact = (key: string) =>
			(
				store.query("SELECT value FROM facts WHERE key=?").get(key) as {
					value: string;
				} | null
			)?.value;
		if (fact(`lane.${sid}.state`) !== "PAUSED")
			throw new Error("Restart requires canonical PAUSED");
		const proof = verifiedPauseCheckpoint(
			JSON.parse(fact(`lane.${sid}.capsule`) ?? "null"),
			cwd,
		);
		if (!proof)
			throw new Error(
				"Restart requires a real ancestor checkpoint and capsule",
			);
		return { claim, checkpoint: proof.checkpoint };
	} finally {
		store.close();
	}
}
export function readFrames(path: string): Array<Record<string, unknown>> {
	if (statSync(path).size > 128 * 1024 * 1024)
		throw new Error("Restart log exceeds bounded evidence limit");
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}
export function children(pid: number): number[] {
	const result = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw new Error("Native child inspection unavailable");
	return result.stdout
		.toString()
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(Number);
}
export async function verifyRestartDrain(
	front: string,
	sid: string,
	headers: Record<string, string>,
): Promise<void> {
	const query = new URLSearchParams({
		limit: "500",
		inference: "true",
		lane: sid,
	});
	const response = await fetch(`${front}/v1/admin/requests?${query}`, {
		headers,
		signal: AbortSignal.timeout(5000),
	});
	const body = (await response.json()) as {
		requests?: Array<{ lane?: string; status?: number | null }>;
	};
	if (
		!response.ok ||
		!Array.isArray(body.requests) ||
		body.requests.length >= 500 ||
		body.requests.some((row) => row.lane !== sid)
	)
		throw new Error("Restart scoped inference coverage is unknown");
	if (body.requests.some((row) => row.status == null))
		throw new Error("Restart lane inference has not drained");
}
async function verifyRoute(sid: string, settings: string): Promise<void> {
	const config = privateJson<{ env?: Record<string, string> }>(settings);
	const token = config.env?.ANTHROPIC_AUTH_TOKEN;
	const admin = adminKey();
	if (!token || !admin) throw new Error("Restart key verification unavailable");
	const headers = {
		authorization: `Bearer ${admin}`,
		"content-type": "application/json",
	};
	const verified = await fetch(`${BUCKLE_FRONT}/v1/admin/keys/verify`, {
		method: "POST",
		headers,
		body: JSON.stringify({ key: token }),
		signal: AbortSignal.timeout(5000),
	});
	const key = (await verified.json()) as { valid?: boolean };
	if (!verified.ok || key.valid !== true)
		throw new Error("Restart lane key is not valid");
	await verifyRestartDrain(BUCKLE_FRONT, sid, headers);
}

/** Existing settings use the stable installed-prefix symlink. A pinned old
 * generation is refused rather than freezing an obsolete hook closure. */
function currentSettings(settings: string, installedBin: string): void {
	const config = privateJson<{
		hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
	}>(settings);
	for (const groups of Object.values(config.hooks ?? {}))
		for (const group of groups)
			for (const hook of group.hooks ?? []) {
				if (
					hook.command?.includes("suspenders.generation-") &&
					!hook.command.includes(dirname(installedBin))
				)
					throw new Error(
						"Settings pin an obsolete harness generation; canonical materialization required",
					);
			}
}

export function missingRetiredLane(
	root: string,
	sid: string,
): LaneRef | undefined {
	const store = openStore();
	let item: string;
	try {
		const claims = store
			.query(
				"SELECT id FROM work_items WHERE project=? AND owner_sid=? AND state='CLAIMED'",
			)
			.all(projectIdentity(root), sid) as Array<{ id: string }>;
		if (claims.length !== 1)
			throw Error("Missing registry recovery requires one exact current claim");
		item = claims[0].id;
	} finally {
		store.close();
	}
	const trees = registryWorktrees(root).filter(
		(entry) => entry.branch === `suspenders/${item}`,
	);
	if (trees.length !== 1)
		throw Error(
			"Missing registry recovery requires one exact Git-registered item tree",
		);
	const worktree = trees[0].path;
	const path = restartJournalPath(worktree);
	if (!existsSync(path)) return undefined;
	const journal = privateJson<ClaudeRestartJournal>(path);
	const lane = { sid, item, worktree, pid: journal.snapshot?.oldWrapper?.pid };
	if (!lane.pid) throw Error("Original retired wrapper binding unavailable");
	const snapshot = retiredRestartSnapshot(
		path,
		{ ...lane, pid: lane.pid },
		identity,
	);
	if (!snapshot) throw Error("Original retired journal unavailable");
	// Proves original token, capsule and checkpoint before any route probe or
	// process action; full snapshot hashes are validated again by the caller.
	const authority = claudeRestartAuthority(sid, item, worktree);
	if (
		authority.claim.updated_at !== snapshot.claimRevision ||
		authority.checkpoint !== snapshot.checkpoint
	)
		throw Error("Missing registry original claim or checkpoint changed");
	return lane;
}

export async function restartManagedClaude(
	fleet: string,
	sid: string,
	apply: boolean,
): Promise<ClaudeRestartJournal> {
	const root = canonicalProjectRoot(fleet);
	const recordedLane = loadLaneRegistry<LaneRef>(root).find(
		(row) => row.sid === sid,
	);
	// A retired journal is the original continuation authority. Do not invent
	// an old registry row: carry its binding only until the real new wrapper
	// can be registered under the original claim and journal.
	const lane = recordedLane ?? missingRetiredLane(root, sid);
	if (!lane?.worktree || !lane.pid)
		throw new Error("Restart requires exact live managed registry identity");
	const journalPath = restartJournalPath(lane.worktree);
	const retired = retiredRestartSnapshot(
		journalPath,
		{
			sid,
			item: lane.item,
			worktree: lane.worktree,
			pid: lane.pid,
		},
		identity,
	);
	if (!retired && laneProcessIdentity(lane) !== true)
		throw new Error("Restart requires exact live managed registry identity");
	const sourceSettings = join(root, ".fleet", `lane-settings-${sid}.json`);
	const settings = join(
		lane.worktree,
		".fleet",
		`restart-settings-${sid}.json`,
	);
	const log = join(root, ".fleet", `lane-${sid}.log`);
	const runtime =
		retired?.runtime ??
		new URL("../../hooks/bin/claude-runtime.ts", import.meta.url).pathname;
	currentSettings(sourceSettings, dirname(runtime));
	privateJson(sourceSettings);
	const sourceData = readFileSync(sourceSettings, "utf8");
	const generated = materializeRestartSettings(sourceData, dirname(runtime));
	if (
		!existsSync(join(dirname(runtime), "lane-model-pin.ts")) ||
		!existsSync(join(dirname(runtime), "..", "gate.ts"))
	)
		throw new Error("Current installed owned hook closure is incomplete");
	const frames = readFrames(log);
	const session = frames.findLast(
		(frame) => frame.type === "system" && frame.subtype === "init",
	)?.session_id;
	if (typeof session !== "string" || !/^[a-f0-9-]{36}$/.test(session))
		throw new Error("Native session UUID is not proven");
	const { claim, checkpoint } = claudeRestartAuthority(
		sid,
		lane.item,
		lane.worktree,
	);
	if (!pausedNativeBoundary(frames, checkpoint))
		throw new Error("Managed native result did not confirm current pause");
	const wrapper = retired?.oldWrapper ?? identity(lane.pid);
	const nativePids = retired ? [] : children(lane.pid);
	const native =
		retired?.oldNative ??
		(nativePids.length === 1 ? identity(nativePids[0]) : null);
	const nativeProcess = native && processBirth(native.pid);
	if (
		!wrapper ||
		!native ||
		(!retired && !nativeProcess?.command.includes(sourceSettings))
	)
		throw new Error("Managed child identity unavailable");
	const controlRecord = () => {
		const rows = loadLaneRegistry<LaneRef>(root);
		const current = rows.find((row) => row.sid === sid);
		if (JSON.stringify(current) !== JSON.stringify(recordedLane))
			throw new Error("Restart registry snapshot changed");
		if (
			!recordedLane &&
			rows.some(
				(row) => row.item === lane.item || row.worktree === lane.worktree,
			)
		)
			throw Error(
				"Missing restart registry scope was claimed by another incarnation",
			);
		const store = openStore();
		try {
			const intent = launchIntent(store, claim.project, lane.item);
			if (
				!intent ||
				intent.sid !== sid ||
				intent.state !== "REGISTERED" ||
				intent.pid !== wrapper.pid ||
				intent.birth !== wrapper.birth
			)
				throw new Error("Restart registered launch intent is not proven");
		} finally {
			store.close();
		}
	};
	controlRecord();
	const binary = retired?.nativeBin ?? nativeProcess?.command.split(/\s+/)[0];
	if (!binary || !/^\//.test(binary))
		throw new Error("Native executable is not absolute");
	const transcripts = Array.from(
		new Bun.Glob(`*/${session}.jsonl`).scanSync(
			join(homedir(), ".claude", "projects"),
		),
	);
	if (transcripts.length !== 1)
		throw new Error("Exact durable native transcript is not proven");
	const transcript = join(homedir(), ".claude", "projects", transcripts[0]);
	const snapshot: ClaudeRestartSnapshot = retired ?? {
		version: 1,
		id: crypto.randomUUID(),
		sid,
		item: lane.item,
		worktree: lane.worktree,
		checkpoint,
		nativeSession: session,
		nativeBin: binary,
		transcript,
		transcriptHash: restartHash(readFileSync(transcript)),
		settings,
		settingsHash: restartHash(generated.data),
		sourceSettings,
		sourceSettingsHash: restartHash(sourceData),
		settingsDelta: generated.delta,
		runtime,
		runtimeHash: restartHash(readFileSync(runtime)),
		claimRevision: claim.updated_at,
		contextHash: restartHash(
			readFileSync(join(lane.worktree, ".fleet", "lane-context.json")),
		),
		treeHash: treeHash(lane.worktree),
		oldWrapper: wrapper,
		oldNative: native,
	};
	if (
		retired &&
		(retired.nativeSession !== session ||
			retired.transcript !== transcript ||
			retired.sourceSettings !== sourceSettings ||
			retired.settings !== settings ||
			retired.settingsHash !== restartHash(generated.data))
	)
		throw new Error("Retired restart execution projection changed");
	const assertLocal = (value: ClaudeRestartSnapshot) => {
		controlRecord();
		const now = claudeRestartAuthority(value.sid, value.item, value.worktree);
		if (
			now.claim.updated_at !== value.claimRevision ||
			restartHash(
				readFileSync(join(value.worktree, ".fleet", "lane-context.json")),
			) !== value.contextHash ||
			now.checkpoint !== value.checkpoint ||
			treeHash(value.worktree) !== value.treeHash ||
			restartHash(readFileSync(value.sourceSettings)) !==
				value.sourceSettingsHash ||
			!restartTranscriptMatches(
				readFileSync(value.transcript),
				value.transcriptHash,
				value.nativeSession,
				identity(value.oldWrapper.pid) === false &&
					identity(value.oldNative.pid) === false,
			)
		)
			throw new Error(
				"Restart authority, checkpoint, edits or settings changed",
			);
		if (
			existsSync(value.settings) &&
			restartHash(readFileSync(value.settings)) !== value.settingsHash
		)
			throw new Error("Materialized settings changed");
		if (restartHash(readFileSync(value.runtime)) !== value.runtimeHash)
			throw new Error("Restart runtime generation changed");
		if (
			identity(value.oldWrapper.pid) !== false &&
			!pausedNativeBoundary(readFrames(log), value.checkpoint)
		)
			throw new Error("Native activity followed the managed pause boundary");
	};
	const validate = async (value: ClaudeRestartSnapshot) => {
		await validateRestartBoundary(value, assertLocal, () =>
			verifyRoute(value.sid, value.sourceSettings),
		);
	};
	await validate(snapshot);
	if (!apply) return { snapshot, phase: retired ? "retired" : "prepared" };
	const temporary = `${settings}.${process.pid}.tmp`;
	writeFileSync(temporary, generated.data, { mode: 0o600, flag: "wx" });
	renameSync(temporary, settings);
	return checkpointedClaudeRestart(journalPath, snapshot, {
		validate: async (value) => {
			await validate(value);
			if (restartHash(readFileSync(value.settings)) !== value.settingsHash)
				throw new Error("Materialized settings changed");
		},
		identity,
		retire: async (old) => {
			await validate(snapshot);
			if (!sameIdentity(old) || !sameIdentity(snapshot.oldNative))
				throw new Error("Old process identity changed before retirement");
			process.kill(old.pid, "SIGTERM");
			const deadline = Date.now() + 10_000;
			while (
				Date.now() < deadline &&
				(identity(old.pid) !== false ||
					identity(snapshot.oldNative.pid) !== false)
			)
				await Bun.sleep(50);
		},
		start: async (value, journal) => {
			const fd = openSync(log, "a", 0o600);
			try {
				const config = privateJson<{ env: Record<string, string> }>(settings);
				const adapter = adapterForExact("claude");
				const child = spawn(
					process.execPath,
					[
						runtime,
						"-p",
						"Await the canonical Fleet resume instruction.",
						...adapter.spawnArgs({ settingsArgs: ["--settings", settings] }),
						"--resume",
						value.nativeSession,
					],
					{
						cwd: value.worktree,
						detached: true,
						stdio: ["ignore", fd, fd],
						env: {
							...process.env,
							...config.env,
							SUSPENDERS_SID: sid,
							SUSPENDERS_SESSION_IDENTITY_PROTOCOL: "canonical-v1",
							KLH_CLAIM_TOKEN: (
								readLaneContextFile(value.worktree) as { claimToken?: string }
							).claimToken,
							SUSPENDERS_CLAUDE_NATIVE_BIN: binary,
							SUSPENDERS_CLAUDE_RESTART_JOURNAL: journal,
						},
					},
				);
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", reject);
				});
				child.unref();
				const found = child.pid && identity(child.pid);
				if (!found) throw new Error("New wrapper birth identity unavailable");
				const deadline = Date.now() + 10_000;
				let waiting = false;
				while (Date.now() < deadline && sameIdentity(found)) {
					waiting = readFrames(log).some(
						(frame) =>
							frame.type === "fleet.claude.restart" &&
							frame.state === "waiting-paused" &&
							frame.id === value.id,
					);
					if (waiting) break;
					await Bun.sleep(25);
				}
				if (!waiting)
					throw new Error("New runtime did not prove silent PAUSED bootstrap");
				return found;
			} finally {
				closeSync(fd);
			}
		},
		register: async (_value, fresh) => {
			const store = openStore();
			try {
				const intent = launchIntent(store, claim.project, lane.item);
				if (
					!intent ||
					intent.sid !== sid ||
					intent.state !== "REGISTERED" ||
					intent.pid !== wrapper.pid ||
					intent.birth !== wrapper.birth
				)
					throw new Error("Restart launch intent binding changed");
				const commit = (publishMissing?: () => void) => {
					const liveClaim = store
						.query(
							"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state='CLAIMED' AND updated_at=?",
						)
						.get(claim.project, lane.item, sid, snapshot.claimRevision);
					const paused = store
						.query("SELECT 1 FROM facts WHERE key=? AND value='PAUSED'")
						.get(`lane.${sid}.state`);
					if (!liveClaim || !paused)
						throw new Error("Restart authority changed before registration");
					const result = store
						.query(
							"UPDATE lane_launch_intents SET pid=?,birth=? WHERE project=? AND item=? AND nonce=? AND pid=? AND birth=? AND sid=? AND state='REGISTERED'",
						)
						.run(
							fresh.pid,
							fresh.birth,
							claim.project,
							lane.item,
							intent.nonce,
							wrapper.pid,
							wrapper.birth,
							sid,
						);
					if (result.changes !== 1)
						throw new Error("Restart launch incarnation CAS failed");
					if (publishMissing) {
						publishMissing();
						store.run(
							"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,?,?,?,?,?)",
							Date.now(),
							"managed-restart",
							"lane.restart.registry-recovered",
							lane.item,
							JSON.stringify({
								project: claim.project,
								item: lane.item,
								sid,
								journalId: snapshot.id,
								checkpoint: snapshot.checkpoint,
								claimRevision: snapshot.claimRevision,
								oldWrapper: snapshot.oldWrapper,
								newWrapper: fresh,
								contextHash: snapshot.contextHash,
								snapshotHash: restartHash(JSON.stringify(snapshot)),
							}),
							sid,
						);
					} else if (
						!repairLaneRegistryPid(
							root,
							lane,
							fresh.pid,
							() => sameIdentity(fresh) && identity(wrapper.pid) === false,
							Date.now(),
						)
					)
						throw new Error("Restart registry incarnation changed");
				};
				store.transaction(() => {
					if (recordedLane) commit();
					else
						registerMissingRestartLane(
							root,
							{
								...lane,
								pid: fresh.pid,
								branch: `suspenders/${snapshot.item}`,
								host: intent.host,
								launchedAt: Date.now(),
								attempt: intent.attempt,
							},
							() =>
								sameIdentity(fresh) &&
								identity(wrapper.pid) === false &&
								identity(snapshot.oldNative.pid) === false,
							commit,
						);
				})();
			} finally {
				store.close();
			}
		},
	});
}

export function verifyManagedClaudeRestart(
	fleet: string,
	sid: string,
): { verified: true; event: number; nativeSession: string } {
	const root = canonicalProjectRoot(fleet);
	const lane = loadLaneRegistry<LaneRef>(root).find((row) => row.sid === sid);
	if (!lane?.worktree || !lane.pid)
		throw new Error("Restart registry binding absent");
	const journal = privateJson<ClaudeRestartJournal>(
		restartJournalPath(lane.worktree),
	);
	const value = journal.snapshot;
	if (
		journal.phase !== "started" ||
		value.sid !== sid ||
		value.item !== lane.item ||
		value.worktree !== lane.worktree ||
		journal.newWrapper?.pid !== lane.pid ||
		!sameIdentity(journal.newWrapper)
	)
		throw new Error("Restart incarnation not proven");
	if (
		restartHash(readFileSync(value.settings)) !== value.settingsHash ||
		restartHash(readFileSync(value.runtime)) !== value.runtimeHash ||
		restartHash(
			readFileSync(join(value.worktree, ".fleet", "lane-context.json")),
		) !== value.contextHash
	)
		throw new Error("Restart settings/runtime proof changed");
	const event = restartContinuationProof(
		journal,
		readFrames(join(root, ".fleet", `lane-${sid}.log`)),
	);
	if (event === null)
		throw new Error(
			"Restart exact UUID, interrupt and subsequent tool not yet proven",
		);
	const store = openStore();
	try {
		const claimed = store
			.query(
				"SELECT claim_token_hash FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state='CLAIMED' AND updated_at=?",
			)
			.get(
				projectIdentity(lane.worktree),
				lane.item,
				sid,
				value.claimRevision,
			) as { claim_token_hash: string | null } | null;
		const token = (
			readLaneContextFile(value.worktree) as { claimToken?: string } | null
		)?.claimToken;
		const running = store
			.query("SELECT 1 FROM facts WHERE key=? AND value='RUNNING'")
			.get(`lane.${sid}.state`);
		const accepted = store
			.query(
				"SELECT 1 FROM direct_message_receipts r JOIN events e ON e.id=r.event_id WHERE r.event_id=? AND r.sid=? AND r.accepted_at IS NOT NULL AND e.kind='NOTE'",
			)
			.get(event, sid);
		if (
			!claimed?.claim_token_hash ||
			!claimTokenVerdict(claimed, token).ok ||
			!running ||
			!accepted
		)
			throw new Error(
				"Restart canonical RUNNING claim and accepted direct event not proven",
			);
		return { verified: true, event, nativeSession: value.nativeSession };
	} finally {
		store.close();
	}
}
