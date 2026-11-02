import { expect, test } from "./pw";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { laneSettingsData } from "../scripts/lib/lane-settings.ts";
import { materializeRestartSettings } from "../scripts/lib/claude-restart-settings.ts";

test("owned materialization repairs the real gate target while preserving routing, key, effort and user fields", () => {
	const bin = new URL("../hooks/bin", import.meta.url).pathname;
	const source = JSON.parse(
		laneSettingsData(
			{
				ANTHROPIC_AUTH_TOKEN: "fixture-only",
				ANTHROPIC_BASE_URL: "http://fixture.invalid/w/exact-lane",
				ANTHROPIC_CUSTOM_HEADERS: "x-prefer:opaque-original",
				SUSPENDERS_LANE_EFFORT: "high",
			},
			"fixture-model",
			bin,
		),
	);
	delete source.env.CLAUDE_CODE_EFFORT_LEVEL;
	source.customUserField = { keep: true };
	source.env.USER_OWNED = "keep";
	source.hooks.PreToolUse[1].hooks[0].command = `${process.execPath} ${bin}/gate.ts runaway`;
	source.hooks.PreToolUse.push({
		matcher: "Edit",
		hooks: [{ type: "command", command: "user-owned-hook" }],
	});
	expect(existsSync(join(bin, "gate.ts"))).toBe(false);
	const result = materializeRestartSettings(JSON.stringify(source), bin);
	const materialized = JSON.parse(result.data);
	expect(materialized.hooks.PreToolUse[1].hooks[0].command).toBe(
		`${process.execPath} ${join(bin, "..", "gate.ts")} runaway`,
	);
	expect(existsSync(join(bin, "..", "gate.ts"))).toBe(true);
	const child = Bun.spawnSync(
		[process.execPath, join(bin, "..", "gate.ts"), "--help"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(child.exitCode).toBe(0);
	expect(materialized.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
	delete materialized.env.CLAUDE_CODE_EFFORT_LEVEL;
	materialized.hooks.PreToolUse[1].hooks[0].command =
		source.hooks.PreToolUse[1].hooks[0].command;
	expect(materialized).toEqual(source);
	expect(result.delta).toEqual([
		"env.CLAUDE_CODE_EFFORT_LEVEL",
		"hooks.PreToolUse.1.hooks.0.command",
	]);
});
