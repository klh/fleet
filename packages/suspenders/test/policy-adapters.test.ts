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
mkdirSync(join(home, ".codex"), { recursive: true });
const existing = {
	hooks: {
		SessionStart: [{ hooks: [{ type: "command", command: "user-existing" }] }],
		Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
	},
	description: "user config",
};
writeFileSync(codexFile, JSON.stringify(existing));

test("canonical adapter install is additive and idempotent", () => {
	installPolicyAdapters({ home, prefix });
	installPolicyAdapters({ home, prefix });
	const value = JSON.parse(readFileSync(codexFile, "utf8"));
	expect(value.description).toBe(existing.description);
	expect(value.hooks.Stop).toEqual(existing.hooks.Stop);
	expect(value.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
	expect(value.hooks.SessionStart).toHaveLength(2);
	const copilot = JSON.parse(
		readFileSync(
			join(home, ".copilot/hooks/fleet-session-policy.json"),
			"utf8",
		),
	);
	expect(copilot.version).toBe(1);
	expect(copilot.hooks.sessionStart[0].args).toEqual([
		join(prefix, "bin/session-policy-hook.ts"),
		"copilot",
	]);
});

test("dry run does not write and symlink configuration is refused", () => {
	const other = join(home, "dry");
	installPolicyAdapters({ home: other, prefix, dryRun: true });
	expect(() => readFileSync(join(other, ".codex/hooks.json"))).toThrow();
	const link = join(home, "linked");
	mkdirSync(link);
	symlinkSync(codexFile, join(link, "hooks.json"));
	expect(() =>
		installPolicyAdapters({ home, prefix, codexHome: link }),
	).toThrow("symlink");
});

test("an unrelated Copilot hook refuses adoption before changing Codex", () => {
	const other = join(home, "unrelated");
	mkdirSync(join(other, ".codex"), { recursive: true });
	mkdirSync(join(other, ".copilot/hooks"), { recursive: true });
	const prior = JSON.stringify(existing);
	writeFileSync(join(other, ".codex/hooks.json"), prior);
	writeFileSync(
		join(other, ".copilot/hooks/fleet-session-policy.json"),
		JSON.stringify({ description: "user-owned" }),
	);
	expect(() => installPolicyAdapters({ home: other, prefix })).toThrow(
		"unrelated",
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
