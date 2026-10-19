// test/lane-settings.test.ts — W512 lane --settings composer: env grammar
// (W250/W228, unchanged) + the hooks block carrying the Task-pin command.
import { describe, expect, test } from "bun:test";
import {
	laneSettingsData,
	modelPinHookCommand,
	runawayHookCommand,
} from "../scripts/lib/lane-settings.ts";

describe("lane-settings (W512)", () => {
	const env = {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:4101/w/autow512",
		ANTHROPIC_AUTH_TOKEN: "bksk_lane",
	};

	test("env grammar: opus alias + remap + routing + token", () => {
		const s = JSON.parse(laneSettingsData(env, "glm-5.3-flash", "/p/bin")) as {
			env: Record<string, string>;
		};
		expect(s.env.ANTHROPIC_MODEL).toBe("opus");
		expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
		expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3-flash");
		expect(s.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101/w/autow512");
		expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("bksk_lane");
	});

	test("hooks block: Task pin + runaway guard, command hooks, 10s timeouts", () => {
		const s = JSON.parse(laneSettingsData(env, "glm-5.3-flash", "/p/bin")) as {
			hooks: {
				PreToolUse: Array<{
					matcher?: string;
					hooks: Array<{ type: string; command: string; timeout: number }>;
				}>;
			};
		};
		expect(s.hooks.PreToolUse).toHaveLength(2);
		const pin = s.hooks.PreToolUse[0];
		expect(pin.matcher).toBe("Task");
		expect(pin.hooks[0].type).toBe("command");
		expect(pin.hooks[0].timeout).toBe(10);
		const guard = s.hooks.PreToolUse[1];
		expect(guard.matcher).toBeUndefined();
		expect(guard.hooks[0].command).toContain("/gate.ts runaway");
		expect(guard.hooks[0].timeout).toBe(10);
	});

	test("hook command pins the exact model via the prefix bin", () => {
		const cmd = modelPinHookCommand("glm-5.3-flash", "/p/bin");
		expect(cmd).toContain("/p/bin/lane-model-pin.ts --model glm-5.3-flash");
		expect(cmd.startsWith(process.execPath)).toBe(true);
	});

	test("runaway guard: command via prefix bin, thresholds pass through env", () => {
		const cmd = runawayHookCommand("/p/bin");
		expect(cmd).toContain("/p/bin/gate.ts runaway");
		expect(cmd.startsWith(process.execPath)).toBe(true);
		const s = JSON.parse(
			laneSettingsData(
				{ ...env, SUSPENDERS_RUNAWAY_USD_CAP: "4" },
				"glm-5.3-flash",
				"/p/bin",
			),
		) as {
			env: Record<string, string>;
		};
		expect(s.env.SUSPENDERS_RUNAWAY_USD_CAP).toBe("4");
		const clean = JSON.parse(
			laneSettingsData(env, "glm-5.3-flash", "/p/bin"),
		) as {
			env: Record<string, string>;
		};
		expect(clean.env.SUSPENDERS_RUNAWAY_USD_CAP).toBeUndefined();
	});
});
