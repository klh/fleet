#!/usr/bin/env bun
// set-cloud.ts — flip the router's cloud escalation. Used by /local command.
//   bun ~/.claude/local-llm/set-cloud.ts off|on|status
// W791: writes ride mergeWritePrefs — the operator's other prefs sections
// (kev, condense, cost_speed, …) survive a flip even when this process's
// view of the file is stale.
import { readFileSync } from "node:fs";
import { mergeWritePrefs } from "./prefs-lib.ts";

const PREFS = `${process.env.HOME}/.claude/local-llm/prefs.json`;
const mode = process.argv[2] ?? "status";

if (mode === "off") {
	mergeWritePrefs(PREFS, { allow_cloud: false });
	console.log(
		"allow_cloud → false · router is LOCAL-ONLY: no z.ai escalation, clients must not call cloud endpoints directly",
	);
} else if (mode === "on") {
	mergeWritePrefs(PREFS, { allow_cloud: true });
	console.log(
		"allow_cloud → true · cloud escalation re-enabled (COMPLEX+ only, never in cost mode)",
	);
} else {
	const prefs = JSON.parse(readFileSync(PREFS, "utf8")) as {
		allow_cloud?: boolean;
	};
	console.log(
		"allow_cloud:",
		prefs.allow_cloud === false
			? "false (local-only)"
			: String(prefs.allow_cloud ?? true),
	);
}
