import { expect, test } from "./pw";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalClaudeDirectEvent } from "../hooks/lib/executors/claude-wake.ts";

const home = mkdtempSync(join(tmpdir(), "fleet-claude-runtime-"));
test.afterAll(() => rmSync(home, { recursive: true, force: true }));

test("managed runtime cancels active native work and injects into the same conversation", async () => {
	const fixture = join(import.meta.dir, "fixtures/claude-stream-native.ts");
	chmodSync(fixture, 0o700);
	const sid = "managed-runtime-test";
	const child = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "../hooks/bin/claude-runtime.ts"),
			"-p",
			"original",
		],
		{
			env: {
				...process.env,
				HOME: home,
				SUSPENDERS_SID: sid,
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => child.kill(), 5000);
	let output = "";
	let signalled = false;
	const read = (async () => {
		for await (const chunk of child.stdout) {
			output += new TextDecoder().decode(chunk);
			if (!signalled && output.includes('"subtype":"init"')) {
				signalled = true;
				signalClaudeDirectEvent(
					{
						id: 1,
						target: sid,
						source: "peer",
						kind: "NOTE",
						payload: JSON.stringify({ note: "Interrupt the original task" }),
					},
					sid,
					home,
				);
			}
		}
	})();
	const error = new Response(child.stderr).text();
	const code = await child.exited;
	await read;
	clearTimeout(timer);
	expect(await error).toBe("");
	expect(code).toBe(0);
	expect(signalled).toBe(true);
	expect(output).toContain("FIXTURE_INTERRUPT_ACK");
	expect(output).not.toContain("ORIGINAL_COMPLETE");
	const frames = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const initial = frames.find((frame) => frame.subtype === "init");
	const result = frames.find(
		(frame) => frame.result === "FIXTURE_INTERRUPT_ACK",
	);
	expect(initial.pid).toBe(result.pid);
	expect(initial.session_id).toBe(result.session_id);
	expect(
		frames.some(
			(frame) =>
				frame.type === "fleet.claude.delivery" &&
				frame.state === "interrupted-and-injected",
		),
	).toBe(true);
});

test("native exit during interrupt leaves the direct event replayable, not watermarked", async () => {
	const fixture = join(
		import.meta.dir,
		"fixtures/claude-stream-native-exit.ts",
	);
	chmodSync(fixture, 0o700);
	const sid = "managed-runtime-exit-test";
	const child = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "../hooks/bin/claude-runtime.ts"),
			"-p",
			"original",
		],
		{
			env: {
				...process.env,
				HOME: home,
				SUSPENDERS_SID: sid,
				SUSPENDERS_CLAUDE_NATIVE_BIN: fixture,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let output = "";
	let signalled = false;
	const read = (async () => {
		for await (const chunk of child.stdout) {
			output += new TextDecoder().decode(chunk);
			if (!signalled && output.includes('"subtype":"init"')) {
				signalled = true;
				signalClaudeDirectEvent(
					{ id: 7, target: sid, source: "peer", kind: "NOTE", payload: "{}" },
					sid,
					home,
				);
			}
		}
	})();
	const code = await child.exited;
	await read;
	expect(code).toBe(0);
	expect(signalled).toBe(true);
	// the runtime reported the delivery failure, never a terminal result
	expect(output).toContain('"state":"queued"');
	expect(output).not.toContain('"state":"interrupted-and-injected"');
	// replay, exactly once, no churn: the claim was released, so the next
	// consumer re-reads the SAME event (watermark untouched); proof retires
	// it and a further read is null
	const wake = await import("../hooks/lib/executors/claude-wake.ts");
	expect(wake.consumeClaudeWake(sid, home, "managed")).toContain("#7");
	expect(wake.proveClaudeWake(sid, home, "managed")).toBe(true);
	expect(wake.consumeClaudeWake(sid, home, "managed")).toBeNull();
});
