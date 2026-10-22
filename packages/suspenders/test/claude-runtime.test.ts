import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalClaudeDirectEvent } from "../hooks/lib/claude-wake.ts";

const home = mkdtempSync(join(tmpdir(), "fleet-claude-runtime-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Spawn the managed runtime against a fixture; inject one direct event
 * (urgent: interrupt-class, else boundary-class) after the native init. */
async function runManaged(
	sid: string,
	fixtureName: string,
	eventId: number,
	urgent: boolean,
): Promise<{ output: string; code: number }> {
	const fixture = join(import.meta.dir, `fixtures/${fixtureName}`);
	chmodSync(fixture, 0o700);
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
						id: eventId,
						target: sid,
						source: "peer",
						kind: "NOTE",
						payload: JSON.stringify(urgent ? { urgent: "1" } : { note: "hi" }),
					},
					sid,
					home,
				);
			}
		}
	})();
	const code = await child.exited;
	await read;
	clearTimeout(timer);
	return { output, code };
}

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
						payload: JSON.stringify({
							note: "Interrupt the original task",
							urgent: "1",
						}),
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
	// W1035.1.1: delivery proof lands only after the injected turn's result —
	// the `delivered` frame follows the FIXTURE_INTERRUPT_ACK result frame.
	const delivered = frames.findIndex(
		(frame) =>
			frame.type === "fleet.claude.delivery" && frame.state === "delivered",
	);
	const ackResult = frames.findIndex(
		(frame) => frame.result === "FIXTURE_INTERRUPT_ACK",
	);
	expect(delivered).toBeGreaterThan(ackResult);
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
					{
						id: 7,
						target: sid,
						source: "peer",
						kind: "NOTE",
						payload: JSON.stringify({ urgent: "1" }),
					},
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
	const wake = await import("../hooks/lib/claude-wake.ts");
	expect(wake.consumeClaudeWake(sid, home, "managed")?.text).toContain("#7");
	expect(wake.proveClaudeWake(sid, home, "managed")).toBe(true);
	expect(wake.consumeClaudeWake(sid, home, "managed")).toBeNull();
});

test("routine direct notes coalesce at the turn boundary, never interrupt", async () => {
	const sid = "managed-runtime-boundary-test";
	const { output, code } = await runManaged(
		sid,
		"claude-stream-native.ts",
		2,
		false,
	);
	expect(code).toBe(0);
	// the original turn COMPLETED — a routine note never fires the interrupt
	expect(output).toContain("ORIGINAL_COMPLETE");
	expect(output).toContain("FIXTURE_INTERRUPT_ACK");
	const frames = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(
		frames.some(
			(frame) =>
				frame.type === "fleet.claude.delivery" &&
				frame.state === "boundary-injected" &&
				frame.event === "2",
		),
	).toBe(true);
	expect(
		frames.some(
			(frame) =>
				frame.type === "fleet.claude.delivery" &&
				frame.state === "delivered" &&
				frame.event === "2",
		),
	).toBe(true);
});

test("restart after a native crash replays the same event into the new conversation", async () => {
	const sid = "managed-runtime-restart-test";
	// crash leg: the native child dies mid-interrupt, the event stays pending
	const first = await runManaged(sid, "claude-stream-native-exit.ts", 9, true);
	expect(first.code).toBe(0);
	expect(first.output).toContain('"state":"queued"');
	expect(first.output).not.toContain('"state":"delivered"');
	// restart leg: a fresh runtime process is the resume path
	const second = await runManaged(sid, "claude-stream-native.ts", 9, true);
	expect(second.code).toBe(0);
	const frames = second.output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const injected = frames.filter(
		(frame) =>
			frame.type === "fleet.claude.delivery" &&
			(frame.state === "injected" ||
				frame.state === "interrupted-and-injected") &&
			frame.event === "9",
	);
	expect(injected).toHaveLength(1);
	expect(
		frames.some(
			(frame) =>
				frame.type === "fleet.claude.delivery" &&
				frame.state === "delivered" &&
				frame.event === "9",
		),
	).toBe(true);
	// retired exactly once: the watermark advanced, a further read is null
	const wake = await import("../hooks/lib/claude-wake.ts");
	expect(wake.consumeClaudeWake(sid, home, "managed")).toBeNull();
}, 15000);
