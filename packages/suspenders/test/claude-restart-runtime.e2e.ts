import { expect, test } from "./pw";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	restartHash,
	type ClaudeRestartSnapshot,
} from "../hooks/lib/executors/claude-restart.ts";
import { signalClaudeDirectEvent } from "../hooks/lib/executors/claude-wake.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

test("restarted runtime stays silent PAUSED, resumes exact UUID and interrupts active continuation", async () => {
	const f = pausedLaneFixture();
	const settings = join(f.home, "settings.json");
	writeFileSync(settings, "{}", { mode: 0o600 });
	const session = crypto.randomUUID();
	const snapshot: ClaudeRestartSnapshot = {
		version: 1,
		id: "actual-runtime",
		sid: f.sid,
		item: f.id,
		worktree: f.cwd,
		checkpoint: f.sha,
		nativeSession: session,
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
		oldWrapper: { pid: 1, birth: "old" },
		oldNative: { pid: 2, birth: "old" },
	};
	const journal = join(f.home, "restart.json");
	writeFileSync(journal, JSON.stringify({ snapshot, phase: "starting" }), {
		mode: 0o600,
	});
	f.coord(["fact", "set", `lane.${f.sid}.state`, "PAUSE_REQUESTED"]);
	f.coord([
		"capsule",
		"set",
		`--checkpoint=${f.sha}`,
		"--done=real fixture checkpoint",
		"--next=continue fixture",
	]);
	f.coord(["paused", "--sha", f.sha]);
	const native = join(import.meta.dir, "fixtures/claude-stream-restart.ts");
	chmodSync(native, 0o700);
	const child = Bun.spawn(
		[
			process.execPath,
			join(f.hooks, "bin/claude-runtime.ts"),
			"-p",
			"must not send",
			"--settings",
			settings,
			"--resume",
			session,
		],
		{
			cwd: f.cwd,
			env: {
				...f.env,
				SUSPENDERS_CLAUDE_NATIVE_BIN: native,
				SUSPENDERS_CLAUDE_RESTART_JOURNAL: journal,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => child.kill(), 8000);
	const frames: Array<Record<string, unknown>> = [];
	const signal = (id: number, kind: string) =>
		signalClaudeDirectEvent(
			{
				id,
				kind,
				target: f.sid,
				source: "operator",
				payload: JSON.stringify({ note: "bounded restart acceptance" }),
			},
			f.sid,
			f.home,
		);
	try {
		const reading = (async () => {
			let pending = "";
			for await (const chunk of child.stdout) {
				pending += new TextDecoder().decode(chunk);
				let at = pending.indexOf("\n");
				while (at >= 0) {
					const frame = JSON.parse(pending.slice(0, at));
					pending = pending.slice(at + 1);
					at = pending.indexOf("\n");
					frames.push(frame);
					if (
						frame.type === "fleet.claude.restart" &&
						frame.state === "waiting-paused"
					) {
						await Bun.sleep(40);
						expect(frames.some((row) => row.subtype === "init")).toBe(false);
						f.coord(["resume", f.sid, "--onto", f.sha]);
						expect(signal(20, "resume_ready")).toBe(true);
					}
					if (
						frame.type === "fleet.fixture.restart" &&
						frame.state === "resuming-active"
					)
						expect(signal(21, "NOTE")).toBe(true);
				}
			}
		})();
		expect(await child.exited).toBe(0);
		await reading;
		expect(await new Response(child.stderr).text()).toBe("");
		expect(frames.find((frame) => frame.subtype === "init")?.session_id).toBe(
			session,
		);
		expect(
			frames.find((frame) => frame.result === "RESTART_INTERRUPT_ACK")
				?.session_id,
		).toBe(session);
		expect(
			frames.some(
				(frame) =>
					frame.type === "fleet.claude.delivery" &&
					frame.state === "interrupted-and-injected" &&
					frame.event === "21",
			),
		).toBe(true);
		expect(frames.some((frame) => frame.result === "UNINTERRUPTED")).toBe(
			false,
		);
	} finally {
		clearTimeout(timer);
		child.kill();
		await child.exited;
		rmSync(f.home, { recursive: true, force: true });
	}
}, 12000);
