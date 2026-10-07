import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function readObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	if (lstatSync(path).isSymbolicLink())
		throw new Error(`refusing hook config symlink: ${path}`);
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid hook configuration");
	return value;
}
function writeObject(path: string, value: unknown, dryRun: boolean): void {
	if (dryRun) return;
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.new`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function installPolicyAdapters(
	options: {
		home?: string;
		prefix?: string;
		codexHome?: string;
		copilotHome?: string;
		codexOnly?: boolean;
		dryRun?: boolean;
	} = {},
): void {
	const home = options.home ?? process.env.HOME ?? "";
	const prefix =
		options.prefix ??
		process.env.SUSPENDERS_PREFIX ??
		join(home, ".claude/hooks/suspenders");
	const adapter = join(prefix, "bin/session-policy-hook.ts");
	if (!existsSync(adapter))
		throw new Error("install Suspenders hook adapter before wiring harnesses");
	const codexFile = join(
		options.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"),
		"hooks.json",
	);
	const codex = readObject(codexFile);
	const hooks = codex.hooks ?? {};
	if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
		throw new Error("invalid Codex hooks map");
	const events = hooks as Record<string, unknown>;
	const groups = events.SessionStart ?? [];
	if (!Array.isArray(groups))
		throw new Error("invalid Codex SessionStart groups");
	const command = `${quote(process.execPath)} ${quote(adapter)} codex`;
	const present = groups.some(
		(group) =>
			Array.isArray(group?.hooks) &&
			group.hooks.some(
				(hook) =>
					hook?.command === command ||
					(typeof hook?.command === "string" &&
						hook.command.includes("/suspenders/session-start.ts")),
			),
	);
	if (!present)
		groups.push({
			matcher: "startup|resume|clear|compact",
			hooks: [{ type: "command", command, timeout: 40 }],
		});
	events.SessionStart = groups;
	codex.hooks = events;
	if (!options.codexOnly) {
		const copilotFile = join(
			options.copilotHome ?? process.env.COPILOT_HOME ?? join(home, ".copilot"),
			"hooks/fleet-session-policy.json",
		);
		const current = readObject(copilotFile);
		if (
			Object.keys(current).length &&
			current.description !== "Fleet session policy adapter"
		)
			throw new Error("refusing unrelated Copilot hook file");
		writeObject(
			copilotFile,
			{
				version: 1,
				description: "Fleet session policy adapter",
				hooks: {
					sessionStart: [
						{
							type: "command",
							exec: process.execPath,
							args: [adapter, "copilot"],
							timeoutSec: 40,
						},
					],
				},
			},
			options.dryRun ?? false,
		);
	}
	writeObject(codexFile, codex, options.dryRun ?? false);
}

if (import.meta.main) {
	if (process.argv.includes("--help"))
		console.log(
			"usage: bun install-policy-adapters.ts [--dry-run] [--codex-only]",
		);
	else {
		installPolicyAdapters({
			dryRun: process.argv.includes("--dry-run"),
			codexOnly: process.argv.includes("--codex-only"),
		});
		console.log(
			"Fleet startup adapters configured. Codex requires review/trust in /hooks before activation; existing hooks preserved.",
		);
	}
}
