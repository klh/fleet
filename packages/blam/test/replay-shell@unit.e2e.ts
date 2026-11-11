import { expect, test } from "@playwright/test";

test("replay shell policy exposes pipeline failures without changing sealed legacy arms @unit", async () => {
	const exports = await import("../bench/sphinx/replay-sandbox.ts");
	const command = Reflect.get(exports, "replayShellCommand");
	expect(
		command,
		"A validated shell-policy command builder is required",
	).toBeDefined();
	const legacy = Bun.spawn(command("false | tail -n 1", "legacy"), {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await legacy.exited).toBe(0);
	const strict = Bun.spawn(command("false | tail -n 1", "pipefail"), {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await strict.exited).not.toBe(0);
	const success = Bun.spawn(command("printf correct | tail -n 1", "pipefail"), {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await new Response(success.stdout).text()).toBe("correct");
	expect(await success.exited).toBe(0);
	expect(() => command("true", "unknown-shell")).toThrow();
});
