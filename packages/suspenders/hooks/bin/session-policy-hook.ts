// Native hook protocol adapter: no vendor model or shell command required.
import { join } from "node:path";

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const value = await reader.read();
			if (value.done) break;
			size += value.value.length;
			if (size > limit) throw new Error("hook stream exceeds limit");
			chunks.push(value.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks).toString("utf8");
}

const harness = process.argv[2];
if (!["codex", "copilot"].includes(harness)) {
	console.error(
		"usage: bun session-policy-hook.ts codex|copilot < hook-payload.json",
	);
	process.exit(2);
}
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
	const raw = await readBounded(Bun.stdin.stream(), 64 * 1024);
	const input = JSON.parse(raw);
	const sid = input.session_id ?? input.sessionId;
	if (typeof sid !== "string" || !sid || typeof input.cwd !== "string")
		throw new Error("hook session ID and cwd required");
	const proc = Bun.spawn(
		[process.execPath, join(import.meta.dir, "..", "session-start.ts")],
		{ cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
	);
	child = proc;
	proc.stdin.write(
		JSON.stringify({
			session_id: sid,
			cwd: input.cwd,
			source: input.source ?? "startup",
			transcript_path: input.transcript_path,
		}),
	);
	proc.stdin.end();
	const context = await readBounded(proc.stdout, 256 * 1024);
	if ((await proc.exited) !== 0 || context.length > 256 * 1024)
		throw new Error("session bootstrap unavailable");
	console.log(
		JSON.stringify(
			harness === "copilot"
				? { additionalContext: context.trim() }
				: {
						hookSpecificOutput: {
							hookEventName: "SessionStart",
							additionalContext: context.trim(),
						},
					},
		),
	);
} catch {
	child?.kill();
	const context =
		"POLICY CHECK UNAVAILABLE: session bootstrap could not run; compliance is unknown.";
	console.log(
		JSON.stringify(
			harness === "copilot"
				? { additionalContext: context }
				: {
						hookSpecificOutput: {
							hookEventName: "SessionStart",
							additionalContext: context,
						},
					},
		),
	);
}
