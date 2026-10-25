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
	// Marker-based, not exact-command: a bun upgrade changes process.execPath
	// (Cellar version path), and re-detecting by exact string would stack a
	// second managed group instead of converging.
	const present = groups.some(
		(group) =>
			Array.isArray(group?.hooks) &&
			group.hooks.some(
				(hook) =>
					typeof hook?.command === "string" &&
					hook.command.includes("/session-policy-hook.ts"),
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
		// Copilot CLI (>=1.0) reads hooks from the inline `hooks` field of
		// ~/.copilot/settings.json (docs.github.com/copilot/reference/
		// hooks-reference) — same schema as Claude's settings.json. Merge our
		// SessionStart group additively; never touch other events or entries.
		const copilotFile = join(
			options.copilotHome ?? process.env.COPILOT_HOME ?? join(home, ".copilot"),
			"settings.json",
		);
		const settings = readObject(copilotFile);
		const hooks = settings.hooks ?? {};
		if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
			throw new Error("invalid Copilot hooks map");
		const events = hooks as Record<string, unknown>;
		const groups = events.SessionStart ?? [];
		if (!Array.isArray(groups))
			throw new Error("invalid Copilot SessionStart groups");
		const command = `${quote(process.execPath)} ${quote(adapter)} copilot`;
		const present = groups.some(
			(group) =>
				Array.isArray(group?.hooks) &&
				group.hooks.some(
					(hook) =>
						typeof hook?.command === "string" &&
						hook.command.includes("/session-policy-hook.ts"),
				),
		);
		if (!present)
			groups.push({
				hooks: [{ type: "command", command }],
			});
		events.SessionStart = groups;
		settings.hooks = events;
		writeObject(copilotFile, settings, options.dryRun ?? false);
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
