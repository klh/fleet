// test/lane-settings.test.ts — W512 lane --settings composer: env grammar
// (W250/W228, unchanged) + the hooks block carrying the Task-pin command.
import { describe, expect, test } from "bun:test";
import {
	laneSettingsData,
	modelPinHookCommand,
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

	test("hooks block: Task matcher, command hook, 10s timeout", () => {
		const s = JSON.parse(laneSettingsData(env, "glm-5.3-flash", "/p/bin")) as {
			hooks: {
				PreToolUse: Array<{
					matcher: string;
					hooks: Array<{ type: string; command: string; timeout: number }>;
				}>;
			};
		};
		expect(s.hooks.PreToolUse).toHaveLength(1);
		const g = s.hooks.PreToolUse[0];
		expect(g.matcher).toBe("Task");
		expect(g.hooks[0].type).toBe("command");
		expect(g.hooks[0].timeout).toBe(10);
	});

	test("hook command pins the exact model via the prefix bin", () => {
		const cmd = modelPinHookCommand("glm-5.3-flash", "/p/bin");
		expect(cmd).toContain("/p/bin/lane-model-pin.ts --model glm-5.3-flash");
		expect(cmd.startsWith(process.execPath)).toBe(true);
	});
});
