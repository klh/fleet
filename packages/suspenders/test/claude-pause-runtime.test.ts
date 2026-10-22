import { expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { signalClaudeDirectEvent } from "../hooks/lib/claude-wake.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

async function exercisePause(interruptDuringResume: boolean): Promise<void> {
	const { home, cwd, sid, env: fixtureEnv } = pausedLaneFixture();
	const env = {
		...fixtureEnv,
		SUSPENDERS_FIXTURE_RESUME_ACTIVE: interruptDuringResume ? "1" : "0",
		SUSPENDERS_CLAUDE_NATIVE_BIN: join(
			import.meta.dir,
			"fixtures/claude-stream-pause.ts",
		),
	};
	chmodSync(env.SUSPENDERS_CLAUDE_NATIVE_BIN, 0o700);
	const coord = join(import.meta.dir, "../hooks/bin/coord.ts");
	const call = async (args: string[]) => {
		const p = Bun.spawn([process.execPath, coord, ...args, "--as", sid], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		if ((await p.exited) !== 0) throw new Error(`${out}\n${err}`);
		return out;
	};
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "../hooks/bin/claude-runtime.ts"),
			"-p",
			"original",
		],
		{ cwd, env, stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => child.kill(), 8000);
	const frames: Record<string, unknown>[] = [];
	let paused = false;
	const signal = (id: number, kind: string) =>
		signalClaudeDirectEvent(
			{
				id,
				target: sid,
				source: "coordinator",
				kind,
				payload: JSON.stringify({ reason: "fixture maintenance" }),
			},
			sid,
			home,
		);
	try {
		const read = (async () => {
			let pending = "";
			for await (const chunk of child.stdout) {
				pending += new TextDecoder().decode(chunk);
				let i = pending.indexOf("\n");
				while (i >= 0) {
					const line = pending.slice(0, i);
					pending = pending.slice(i + 1);
					i = pending.indexOf("\n");
					const frame = JSON.parse(line);
					frames.push(frame);
					if (frame.subtype === "init") {
						await call(["fact", "set", `lane.${sid}.state`, "PAUSE_REQUESTED"]);
						expect(signal(10, "pause_requested")).toBe(true);
					}
					if (
						frame.type === "fleet.fixture.resume" &&
						frame.state === "active"
					) {
						expect(signal(13, "NOTE")).toBe(true);
					}
					if (frame.type === "fleet.claude.pause" && frame.state === "paused") {
						paused = true;
						expect(frame.checkpoint).toMatch(/^[a-f0-9]{40}$/);
						expect(
							await call(["fact", "get", `lane.${sid}.state`]),
						).toStartWith("PAUSED ");
						signal(11, "NOTE");
						await Bun.sleep(40);
						expect(child.exitCode).toBeNull();
						await call(["resume", sid, "--onto", frame.checkpoint]);
						expect(signal(12, "resume_ready")).toBe(true);
					}
				}
			}
		})();
		const errors = new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		await read;
		expect(await errors).toBe("");
		expect(paused).toBe(true);
		expect(
			frames.some(
				(f) =>
					f.type === "fleet.fixture.stop" && f.state === "allowed-after-pause",
			),
		).toBe(true);
		expect(
			frames.some(
				(f) => f.type === "fleet.claude.pause" && f.state === "resumed",
			),
		).toBe(true);
		expect(frames.some((f) => f.state === "deferred-while-paused")).toBe(true);
		expect(
			frames.some(
				(f) =>
					f.result === "ORIGINAL_COMPLETE" ||
					f.result === "UNEXPECTED_NORMAL_WORK",
			),
		).toBe(false);
		expect(
			frames.find(
				(f) =>
					f.result === (interruptDuringResume ? "DIRECT_DELIVERED" : "RESUMED"),
			)?.pid,
		).toBe(frames.find((f) => f.subtype === "init")?.pid);
		if (interruptDuringResume) {
			expect(
				frames.some(
					(f) =>
						f.type === "fleet.claude.delivery" &&
						f.event === "13" &&
						f.state === "interrupted-and-injected",
				),
			).toBe(true);
			expect(frames.some((f) => f.result === "RESUMED")).toBe(false);
		}
		expect(await call(["fact", "get", `lane.${sid}.state`])).toStartWith(
			"RUNNING ",
		);
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
		await child.exited;
		rmSync(home, { recursive: true, force: true });
	}
}

test(
	"managed pause checkpoints through canonical CLI, waits idle, and resumes the same native process",
	() => exercisePause(false),
	10000,
);

test(
	"direct messages interrupt active resumed work in the same native process",
	() => exercisePause(true),
	10000,
);
