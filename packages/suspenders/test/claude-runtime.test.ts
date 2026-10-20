import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalClaudeDirectEvent } from "../hooks/lib/claude-wake.ts";

const home = mkdtempSync(join(tmpdir(), "fleet-claude-runtime-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

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
