// test/lane-model-pin.test.ts — W512 Task-layer model pin hook: the REAL
// script over the stdin/stdout wire the CLI drives, plus the pure helper.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { taskPinOutput } from "../hooks/bin/lane-model-pin.ts";

const PIN = join(import.meta.dir, "..", "hooks", "bin", "lane-model-pin.ts");

const runPin = (
	stdin: string,
	args: string[] = ["--model", "glm-5.3-flash"],
): { out: string; err: string; code: number | null } => {
	const p = Bun.spawnSync([process.execPath, PIN, ...args], {
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
		code: p.exitCode,
	};
};

const taskPayload = (toolInput: unknown): string =>
	JSON.stringify({
		hook_event_name: "PreToolUse",
		tool_name: "Task",
		tool_input: toolInput,
	});

describe("lane-model-pin (W512)", () => {
	test("Task call emits updatedInput with the pinned model, input preserved", () => {
		const r = runPin(taskPayload({ subagent_type: "Explore", prompt: "x" }));
		expect(r.code).toBe(0);
		const o = JSON.parse(r.out) as {
			hookSpecificOutput: {
				hookEventName: string;
				updatedInput: Record<string, unknown>;
				permissionDecision?: string;
			};
		};
		expect(o.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		// no permissionDecision — the pin rewrites, permission flow still gates
		expect(o.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(o.hookSpecificOutput.updatedInput.subagent_type).toBe("Explore");
		expect(o.hookSpecificOutput.updatedInput.prompt).toBe("x");
		expect(o.hookSpecificOutput.updatedInput.model).toBe("glm-5.3-flash");
	});

	test("subagent-requested model is overridden by the pin", () => {
		const r = runPin(taskPayload({ model: "haiku", prompt: "cheap" }));
		const o = JSON.parse(r.out) as {
			hookSpecificOutput: { updatedInput: { model: string } };
		};
		expect(o.hookSpecificOutput.updatedInput.model).toBe("glm-5.3-flash");
	});

	test("non-Task payload passes through with no output", () => {
		const r = runPin(
			JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
		);
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
	});

	test("malformed stdin exits 0 silently (fail-open)", () => {
		const r = runPin("{not json");
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
	});

	test("missing --model exits 0 with a stderr note (fail-open)", () => {
		const r = runPin(taskPayload({ prompt: "x" }), []);
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
		expect(r.err).toContain("--model");
	});

	test("null tool_input still pins the model", () => {
		const o = taskPinOutput("Task", null, "glm-5.3-flash");
		expect(o).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: { model: "glm-5.3-flash" },
			},
		});
	});

	test("non-object tool_input (array) does not spread", () => {
		const o = taskPinOutput("Task", ["a"], "m1");
		expect(o).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: { model: "m1" },
			},
		});
	});
});
