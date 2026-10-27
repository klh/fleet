import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	checkpointedClaudeRestart,
	restartBootstrap,
	restartHash,
	restartContinuationProof,
	pausedNativeBoundary,
	validateRestartBoundary,
	restartTranscriptMatches,
	retiredRestartSnapshot,
	type ClaudeRestartSnapshot,
	type RestartDependencies,
} from "../hooks/lib/executors/claude-restart.ts";
import { processBirth } from "../scripts/lib/launch-fencing.ts";

const directories: string[] = [];
test.afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-driver-restart-"));
	directories.push(dir);
	const settings = join(dir, "settings.json");
	writeFileSync(settings, '{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-only"}}', {
		mode: 0o600,
	});
	const snapshot: ClaudeRestartSnapshot = {
		version: 1,
		id: "test-operation",
		sid: "test-lane",
		item: "W1",
		worktree: process.cwd(),
		checkpoint: "a".repeat(40),
		nativeSession: "7cb949c4-36d5-4db8-b426-84f47a733220",
		nativeBin: process.execPath,
		transcript: settings,
		transcriptHash: restartHash(readFileSync(settings)),
		settings,
		settingsHash: restartHash(readFileSync(settings)),
		sourceSettings: settings,
		sourceSettingsHash: restartHash(readFileSync(settings)),
		settingsDelta: [],
		runtime: new URL("../hooks/bin/claude-runtime.ts", import.meta.url)
			.pathname,
		runtimeHash: restartHash(
			readFileSync(new URL("../hooks/bin/claude-runtime.ts", import.meta.url)),
		),
		claimRevision: 1,
		contextHash: "fixture-context",
		treeHash: "fixture",
		oldWrapper: { pid: 100, birth: "old-wrapper" },
		oldNative: { pid: 101, birth: "old-native" },
	};
	const path = join(dir, "journal.json");
	const live = new Map([
		[100, "old-wrapper"],
		[101, "old-native"],
	]);
	const actions: string[] = [];
	const deps: RestartDependencies = {
		validate: async () => {
			actions.push("validate");
		},
		identity: (pid) =>
			live.has(pid) ? { pid, birth: live.get(pid) ?? "" } : false,
		retire: async () => {
			actions.push("retire");
			live.clear();
		},
		start: async () => {
			actions.push("start");
			live.set(200, "new-wrapper");
			return { pid: 200, birth: "new-wrapper" };
		},
		register: async () => {
			actions.push("register");
		},
	};
	return { path, snapshot, deps, live, actions };
}
test("checkpointed restart reserves phases and preserves lane authority", async () => {
	const f = fixture();
	const result = await checkpointedClaudeRestart(f.path, f.snapshot, f.deps);
	expect(result.phase).toBe("started");
	expect(result.snapshot).toEqual(f.snapshot);
	expect(f.actions).toEqual([
		"validate",
		"retire",
		"validate",
		"start",
		"register",
	]);
	expect(readFileSync(f.path, "utf8")).not.toContain("fixture-only");
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("reconcile before retry");
	expect(f.actions.filter((x) => x === "start")).toHaveLength(1);
});
test.each([
	"active inference",
	"stale claim",
	"changed dirty files",
	"missing capsule",
	"invalid key",
])("refuses %s before retirement", async (reason) => {
	const f = fixture();
	f.deps.validate = async () => {
		throw new Error(reason);
	};
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow(reason);
	expect(f.actions).toEqual([]);
});
test("reused or unknown PID never receives retirement signal", async () => {
	const f = fixture();
	f.live.set(100, "unrelated-reused-pid");
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("identity changed");
	expect(f.actions).toEqual(["validate"]);
});
test("native that remains alive prevents replacement", async () => {
	const f = fixture();
	f.deps.retire = async () => {
		f.live.delete(100);
	};
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("both exited");
	expect(f.actions).not.toContain("start");
});
test("crash in start is uncertain and retry cannot duplicate launch", async () => {
	const f = fixture();
	let calls = 0;
	f.deps.start = async () => {
		calls++;
		throw new Error("lost spawn receipt");
	};
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("lost spawn receipt");
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("starting");
	expect(calls).toBe(1);
});
test("bootstrap preserves exact persisted UUID and refuses fork, wrong UUID or changed settings", () => {
	const f = fixture();
	writeFileSync(
		f.path,
		JSON.stringify({ snapshot: f.snapshot, phase: "starting" }),
		{ mode: 0o600 },
	);
	const args = [
		"-p",
		"wait",
		"--settings",
		f.snapshot.settings,
		"--resume",
		f.snapshot.nativeSession,
	];
	expect(restartBootstrap(f.path, f.snapshot.sid, args)).toEqual(f.snapshot);
	expect(() =>
		restartBootstrap(f.path, f.snapshot.sid, [...args, "--fork-session"]),
	).toThrow("exact native session");
	expect(() =>
		restartBootstrap(
			f.path,
			f.snapshot.sid,
			args.map((arg) =>
				arg === f.snapshot.nativeSession ? crypto.randomUUID() : arg,
			),
		),
	).toThrow("exact native session");
	writeFileSync(f.snapshot.settings, "{}");
	expect(() => restartBootstrap(f.path, f.snapshot.sid, args)).toThrow(
		"settings changed",
	);
});

test("checkpointed retirement waits for both actual child processes before one replacement", async () => {
	const f = fixture();
	const old = Bun.spawn(
		[
			process.execPath,
			"-e",
			'const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore"});console.log(child.pid);process.on("SIGTERM",async()=>{child.kill("SIGTERM");await child.exited;process.exit(0);});setInterval(()=>{},1000);',
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = old.stdout.getReader();
	const line = await reader.read();
	reader.releaseLock();
	const nativePid = Number(new TextDecoder().decode(line.value).trim());
	const oldBirth = processBirth(old.pid);
	const nativeBirth = processBirth(nativePid);
	if (!oldBirth || !nativeBirth)
		throw new Error("Fixture process births unavailable");
	f.snapshot.oldWrapper = { pid: old.pid, birth: oldBirth.birth };
	f.snapshot.oldNative = { pid: nativePid, birth: nativeBirth.birth };
	let replacement: Bun.Subprocess | undefined;
	f.deps.identity = (pid) => {
		const birth = processBirth(pid);
		return birth && { pid, birth: birth.birth };
	};
	f.deps.retire = async () => {
		old.kill("SIGTERM");
		await old.exited;
	};
	f.deps.start = async () => {
		expect(processBirth(old.pid)).toBe(false);
		expect(processBirth(nativePid)).toBe(false);
		replacement = Bun.spawn(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const birth = processBirth(replacement.pid);
		if (!birth) throw new Error("Replacement birth missing");
		return { pid: replacement.pid, birth: birth.birth };
	};
	try {
		const result = await checkpointedClaudeRestart(f.path, f.snapshot, f.deps);
		expect(result.phase).toBe("started");
		expect(result.newWrapper?.pid).not.toBe(old.pid);
		expect(result.newWrapper?.pid).not.toBe(nativePid);
	} finally {
		old.kill();
		if (replacement) {
			replacement.kill();
			await replacement.exited;
		}
		await old.exited;
	}
});

test("acceptance excludes old log events, wrong UUID, queued delivery and no subsequent work", () => {
	const f = fixture();
	const journal = { snapshot: f.snapshot, phase: "started" as const };
	const frames = [
		{
			type: "fleet.claude.restart",
			state: "waiting-paused",
			id: f.snapshot.id,
		},
		{ type: "system", subtype: "init", session_id: f.snapshot.nativeSession },
		{
			type: "fleet.claude.delivery",
			state: "interrupted-and-injected",
			event: "91",
		},
		{
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Bash" }] },
		},
	];
	expect(restartContinuationProof(journal, frames)).toBe(91);
	expect(restartContinuationProof(journal, frames.slice(1))).toBeNull();
	expect(restartContinuationProof(journal, frames.slice(0, -1))).toBeNull();
	expect(
		restartContinuationProof(
			journal,
			frames.map((frame) =>
				frame.subtype === "init"
					? { ...frame, session_id: crypto.randomUUID() }
					: frame,
			),
		),
	).toBeNull();
	expect(
		restartContinuationProof(
			journal,
			frames.map((frame) =>
				frame.type === "fleet.claude.delivery"
					? { ...frame, state: "queued" }
					: frame,
			),
		),
	).toBeNull();
});

test("a stale pause frame never proves an active native turn idle", () => {
	const checkpoint = "a".repeat(40);
	const frames = [
		{ type: "result", subtype: "success", is_error: false },
		{ type: "fleet.claude.pause", state: "paused", checkpoint },
	];
	expect(pausedNativeBoundary(frames, checkpoint)).toBe(true);
	expect(
		pausedNativeBoundary([...frames, { type: "assistant" }], checkpoint),
	).toBe(false);
	expect(pausedNativeBoundary([...frames, { type: "user" }], checkpoint)).toBe(
		false,
	);
	expect(pausedNativeBoundary(frames, "b".repeat(40))).toBe(false);
	expect(pausedNativeBoundary(frames.slice(1), checkpoint)).toBe(false);
});

test("a settings mutation during async drain is refused by the final local snapshot assertion", async () => {
	const f = fixture();
	const assertLocal = (snapshot: ClaudeRestartSnapshot) => {
		if (restartHash(readFileSync(snapshot.settings)) !== snapshot.settingsHash)
			throw new Error("local snapshot changed");
	};
	await expect(
		validateRestartBoundary(f.snapshot, assertLocal, async () => {
			await Bun.sleep(1);
			writeFileSync(f.snapshot.settings, "changed while draining");
		}),
	).rejects.toThrow("local snapshot changed");
});

const shutdownRows = (session: string) =>
	`${[
		JSON.stringify({
			type: "last-prompt",
			sessionId: session,
			lastPrompt: "pause",
			leafUuid: "leaf",
		}),
		JSON.stringify({
			type: "cost-state",
			sessionId: session,
			totalCostUSD: 1,
			modelUsage: {},
		}),
	].join("\n")}\n`;
test("shutdown transcript permits only bounded same-session bookkeeping after both processes exit", () => {
	const prefix = Buffer.from(
		`${JSON.stringify({ type: "assistant", message: "checkpoint" })}\n`,
	);
	const session = "7cb949c4-36d5-4db8-b426-84f47a733220",
		hash = restartHash(prefix);
	const valid = Buffer.concat([prefix, Buffer.from(shutdownRows(session))]);
	expect(restartTranscriptMatches(valid, hash, session, true)).toBe(true);
	expect(restartTranscriptMatches(valid, hash, session, false)).toBe(false);
	expect(restartTranscriptMatches(prefix, hash, session, false)).toBe(true);
	const invalid = [
		Buffer.from(valid.toString().replace("checkpoint", "rewritten")),
		Buffer.from(valid.toString().trimEnd()),
		Buffer.concat([prefix, Buffer.from(shutdownRows("foreign"))]),
		...["user", "assistant", "tool"].map((type) =>
			Buffer.concat([
				prefix,
				Buffer.from(`${JSON.stringify({ type, sessionId: session })}\n`),
			]),
		),
		Buffer.concat([prefix, Buffer.from(shutdownRows(session).repeat(2))]),
		Buffer.concat([
			prefix,
			Buffer.from(
				`${JSON.stringify({
					type: "last-prompt",
					sessionId: session,
					message: "injected",
				})}\n`,
			),
		]),
		Buffer.concat([
			prefix,
			Buffer.from(
				`${JSON.stringify({
					type: "last-prompt",
					sessionId: session,
					lastPrompt: "x".repeat(65536),
				})}\n`,
			),
		]),
	];
	for (const bytes of invalid)
		expect(restartTranscriptMatches(bytes, hash, session, true)).toBe(false);
});
test("retired journal is loaded without a live old wrapper and refuses uncertain phases or reused identity", async () => {
	const f = fixture();
	f.live.clear();
	writeFileSync(
		f.path,
		JSON.stringify({ snapshot: f.snapshot, phase: "retired" }),
		{ mode: 0o600 },
	);
	const lane = {
		sid: f.snapshot.sid,
		item: f.snapshot.item,
		worktree: f.snapshot.worktree,
		pid: 100,
	};
	expect(retiredRestartSnapshot(f.path, lane, f.deps.identity)).toEqual(
		f.snapshot,
	);
	expect(() =>
		retiredRestartSnapshot(
			f.path,
			{ ...lane, sid: "foreign" },
			f.deps.identity,
		),
	).toThrow("binding");
	expect(() => retiredRestartSnapshot(f.path, lane, () => null)).toThrow(
		"absence",
	);
	f.live.set(100, "reused-pid");
	expect(() => retiredRestartSnapshot(f.path, lane, f.deps.identity)).toThrow(
		"absence",
	);
	f.live.clear();
	for (const phase of ["retiring", "starting", "started"]) {
		writeFileSync(f.path, JSON.stringify({ snapshot: f.snapshot, phase }), {
			mode: 0o600,
		});
		expect(() => retiredRestartSnapshot(f.path, lane, f.deps.identity)).toThrow(
			"reconcile",
		);
	}
});
test("retired retry preserves the original snapshot and launches once after a native shutdown footer", async () => {
	const f = fixture(),
		transcript = join(dirname(f.path), "transcript.jsonl");
	const prefix =
		JSON.stringify({ type: "assistant", sessionId: f.snapshot.nativeSession }) +
		"\n";
	writeFileSync(transcript, prefix);
	f.snapshot.transcript = transcript;
	f.snapshot.transcriptHash = restartHash(prefix);
	let refuse = true;
	f.deps.validate = async (value) => {
		expect(
			restartTranscriptMatches(
				readFileSync(value.transcript),
				value.transcriptHash,
				value.nativeSession,
				f.live.size === 0,
			),
		).toBe(true);
		if (f.live.size === 0 && refuse) throw Error("temporary drain unavailable");
	};
	f.deps.retire = async () => {
		f.actions.push("retire");
		f.live.clear();
		writeFileSync(transcript, prefix + shutdownRows(f.snapshot.nativeSession));
	};
	await expect(
		checkpointedClaudeRestart(f.path, f.snapshot, f.deps),
	).rejects.toThrow("temporary drain");
	const old = JSON.parse(readFileSync(f.path, "utf8"));
	expect(old.phase).toBe("retired");
	const snapshot = retiredRestartSnapshot(
		f.path,
		{
			sid: f.snapshot.sid,
			item: f.snapshot.item,
			worktree: f.snapshot.worktree,
			pid: 100,
		},
		f.deps.identity,
	);
	if (!snapshot) throw new Error("Retired snapshot missing");
	refuse = false;
	const result = await checkpointedClaudeRestart(f.path, snapshot, f.deps);
	expect(result.snapshot).toEqual(f.snapshot);
	expect(result.phase).toBe("started");
	expect(result.shutdownTranscript).toEqual({
		hash: restartHash(readFileSync(transcript)),
		bytes: readFileSync(transcript).length,
	});
	expect(
		restartBootstrap(f.path, snapshot.sid, [
			"--resume",
			snapshot.nativeSession,
			"--settings",
			snapshot.settings,
		]),
	).toEqual(snapshot);
	expect(f.actions).toEqual(["retire", "start", "register"]);
	await expect(
		checkpointedClaudeRestart(f.path, snapshot, f.deps),
	).rejects.toThrow("reconcile");
});
