import { afterAll, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPolicyAdapters } from "../scripts/install-policy-adapters.ts";

const home = mkdtempSync(join(tmpdir(), "policy-adapter-"));
const prefix = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(home, { recursive: true, force: true }));
const codexFile = join(home, ".codex/hooks.json");
const copilotFile = join(home, ".copilot/settings.json");
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(home, ".copilot"), { recursive: true });
const existing = {
	hooks: {
		SessionStart: [{ hooks: [{ type: "command", command: "user-existing" }] }],
		Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
	},
	description: "user config",
};
writeFileSync(codexFile, JSON.stringify(existing));
const copilotExisting = {
	theme: "dark",
	hooks: {
		SessionStart: [
			{ hooks: [{ type: "command", command: "user-copilot-start" }] },
		],
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [{ type: "command", command: "user-copilot-gate" }],
			},
		],
	},
};
writeFileSync(copilotFile, JSON.stringify(copilotExisting));

test("canonical adapter install is additive and idempotent", () => {
	installPolicyAdapters({ home, prefix });
	installPolicyAdapters({ home, prefix });
	const value = JSON.parse(readFileSync(codexFile, "utf8"));
	expect(value.description).toBe(existing.description);
	expect(value.hooks.Stop).toEqual(existing.hooks.Stop);
	expect(value.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
	expect(value.hooks.SessionStart).toHaveLength(2);
	const copilot = JSON.parse(readFileSync(copilotFile, "utf8"));
	expect(copilot.theme).toBe(copilotExisting.theme);
	expect(copilot.hooks.PreToolUse).toEqual(copilotExisting.hooks.PreToolUse);
	expect(copilot.hooks.SessionStart[0]).toEqual(
		copilotExisting.hooks.SessionStart[0],
	);
	expect(copilot.hooks.SessionStart).toHaveLength(2);
	expect(copilot.hooks.SessionStart[1].hooks[0].command).toContain(
		"/session-policy-hook.ts",
	);
	expect(
		copilot.hooks.SessionStart[1].hooks[0].command.endsWith(" copilot"),
	).toBe(true);
});

test("dry run does not write and symlink configuration is refused", () => {
	const other = join(home, "dry");
	installPolicyAdapters({ home: other, prefix, dryRun: true });
	expect(() => readFileSync(join(other, ".codex/hooks.json"))).toThrow();
	expect(() => readFileSync(join(other, ".copilot/settings.json"))).toThrow();
	const link = join(home, "linked");
	mkdirSync(join(link, ".codex"), { recursive: true });
	mkdirSync(join(link, ".copilot"), { recursive: true });
	symlinkSync(codexFile, join(link, ".codex/hooks.json"));
	symlinkSync(copilotFile, join(link, ".copilot/settings.json"));
	expect(() =>
		installPolicyAdapters({ home, prefix, codexHome: join(link, ".codex") }),
	).toThrow("symlink");
	expect(() =>
		installPolicyAdapters({
			home,
			prefix,
			copilotHome: join(link, ".copilot"),
		}),
	).toThrow("symlink");
});

test("an invalid Copilot hooks map refuses before Codex is written", () => {
	const other = join(home, "invalid");
	mkdirSync(join(other, ".codex"), { recursive: true });
	mkdirSync(join(other, ".copilot"), { recursive: true });
	const prior = JSON.stringify(existing);
	writeFileSync(join(other, ".codex/hooks.json"), prior);
	writeFileSync(
		join(other, ".copilot/settings.json"),
		JSON.stringify({ hooks: "not-a-map" }),
	);
	expect(() => installPolicyAdapters({ home: other, prefix })).toThrow(
		"invalid Copilot hooks map",
	);
	expect(readFileSync(join(other, ".codex/hooks.json"), "utf8")).toBe(prior);
});

test("native Copilot camelCase and Codex snake_case inputs produce supported context envelopes", async () => {
	for (const harness of ["copilot", "codex"]) {
		const cwd = join(home, harness);
		mkdirSync(cwd, { recursive: true });
		const input =
			harness === "copilot"
				? { sessionId: `${harness}-sid`, cwd, source: "startup" }
				: { session_id: `${harness}-sid`, cwd, source: "startup" };
		const path = join(home, `${harness}.json`);
		writeFileSync(path, JSON.stringify(input));
		const proc = Bun.spawn(
			[process.execPath, join(prefix, "bin/session-policy-hook.ts"), harness],
			{
				cwd,
				env: { ...process.env, HOME: cwd },
				stdin: Bun.file(path),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = JSON.parse(await new Response(proc.stdout).text());
		expect(await proc.exited).toBe(0);
		const context =
			harness === "copilot"
				? output.additionalContext
				: output.hookSpecificOutput.additionalContext;
		expect(context).toContain(
			`SESSION ${harness === "copilot" ? "copilot-" : "codex-si"}`,
		);
		if (harness === "codex")
			expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
	}
});
