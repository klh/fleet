// settings.cli.ts — the `coord settings` subcommands (registered on the
// verb-kit in suspenders' coord.ts; this module owns the behaviour so any
// face can mount it). Every write validates the WHOLE document first and
// lands atomically at mode 0600 — an invalid `set` changes nothing.
//
//   settings get <path>                 effective value (JSON)
//   settings set <path> <json>          validate, then atomic write
//   settings unset <path>
//   settings validate
//   settings show [--effective] [--origin]
//   settings schema [--write]
//   settings migrate [--dry-run] [--stack p] [--hubs p] [--env-file p]… [--plist p]…
//   settings render-hub <label>         the hub's rendered settings.json
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { SCHEMA_FILE, settingsJsonSchemaText } from "./settings.jsonschema.ts";
import { migrate } from "./settings.migrate.ts";
import { renderHubSettings } from "./settings.overlay.ts";
import {
	originOf,
	readSettingsFile,
	resolveSettings,
	SettingsError,
	settingsPath,
	validateDoc,
} from "./settings.reader.ts";
import {
	type Doc,
	getPath,
	leafPaths,
	setPath,
	unsetPath,
} from "./settings.tree.ts";

export interface CliIo {
	out: (s: string) => void;
	err: (s: string) => void;
}

const stdio: CliIo = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

const USAGE = [
	"usage: settings get <path> | set <path> <json> | unset <path> | validate",
	"       | show [--effective] [--origin] | schema [--write]",
	"       | migrate [--dry-run] [--stack p] [--hubs p] [--env-file p]... [--plist p]...",
	"       | render-hub <label>",
].join("\n");

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function flagValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++)
		if (args[i] === flag && args[i + 1] !== undefined)
			out.push(args[++i] ?? "");
	return out;
}

const positionals = (args: string[], valued: string[]): string[] => {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		if (valued.includes(a)) i++;
		else if (!a.startsWith("--")) out.push(a);
	}
	return out;
};

/** Validate then atomically write the raw document. */
function writeDoc(file: string, doc: Doc, io: CliIo): number {
	const withSchema: Doc = { $schema: `./${SCHEMA_FILE}`, ...doc };
	const check = validateDoc(withSchema);
	if (!check.ok) {
		io.err(
			`settings: refused — the result would be invalid:\n  ${check.issues.join("\n  ")}\n`,
		);
		return 1;
	}
	atomicWrite0600(file, json(withSchema));
	return 0;
}

const parseValue = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

function loadRaw(file: string, io: CliIo): Doc | null {
	try {
		return readSettingsFile(file) ?? {};
	} catch (e) {
		io.err(`settings: ${file} is not valid JSON: ${String(e)}\n`);
		return null;
	}
}

function cmdShow(args: string[], io: CliIo): number {
	const r = resolveSettings({ mode: "service", quiet: true });
	if (args.includes("--origin")) {
		for (const p of leafPaths(r.settings))
			io.out(
				`${p} = ${JSON.stringify(getPath(r.settings, p))}  (${originOf(r, p)})\n`,
			);
		return 0;
	}
	io.out(json(args.includes("--effective") ? r.settings : r.file));
	return 0;
}

const listDir = (dir: string, re: RegExp): string[] => {
	try {
		return readdirSync(dir)
			.filter((f) => re.test(f))
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
};

function cmdMigrate(args: string[], io: CliIo): number {
	const home = process.env.HOME ?? homedir();
	const file = settingsPath();
	const stackPath =
		flagValues(args, "--stack")[0] ??
		process.env.KLH_STACK ??
		join(home, ".config", "klh", "stack.json");
	const hubsPath =
		flagValues(args, "--hubs")[0] ??
		process.env.SUSPENDERS_HUBS_FILE ??
		join(home, ".claude", "local-llm", "hubs.json");
	const envFiles = flagValues(args, "--env-file");
	const plists = flagValues(args, "--plist");
	const envSources = envFiles.length
		? envFiles
		: listDir(join(home, ".claude", "local-llm"), /\.env$/);
	const plistSources = plists.length
		? plists
		: listDir(
				join(home, "Library", "LaunchAgents"),
				/^com\.(suspenders|belt)\..*\.plist$/,
			);
	const read = (p: string): string | null => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return null;
		}
	};
	const readJson = (p: string): Doc | null => {
		const t = read(p);
		return t ? (JSON.parse(t) as Doc) : null;
	};
	const existing = loadRaw(file, io);
	if (existing === null) return 1;
	const res = migrate({
		stack: readJson(stackPath),
		hubsRegistry: readJson(hubsPath),
		envTexts: envSources.map(read).filter((t): t is string => t !== null),
		plistTexts: plistSources.map(read).filter((t): t is string => t !== null),
		existing,
		secretsDir: join(dirname(file), "secrets"),
	});
	for (const line of res.report) io.out(`migrate: ${line}\n`);
	if (res.issues.length) {
		io.err(`settings: migrate refused:\n  ${res.issues.join("\n  ")}\n`);
		return 1;
	}
	if (args.includes("--dry-run")) {
		io.out(json(res.doc));
		return 0;
	}
	for (const [path, content] of Object.entries(res.secrets)) {
		if (existsSync(path) && readFileSync(path, "utf8") !== content) {
			io.err(
				`settings: ${path} exists with different content — not overwritten\n`,
			);
			return 1;
		}
		atomicWrite0600(path, content);
	}
	const code = writeDoc(file, res.doc, io);
	if (code !== 0) return code;
	atomicWrite0600(join(dirname(file), SCHEMA_FILE), settingsJsonSchemaText());
	if (existsSync(stackPath) && !existsSync(`${stackPath}.bak`))
		copyFileSync(stackPath, `${stackPath}.bak`);
	io.out(
		`migrate: wrote ${file} (stack.json kept as read-compat fallback for one release)\n`,
	);
	return 0;
}

export function runSettingsCli(argv: string[], io: CliIo = stdio): number {
	const [sub, ...args] = argv;
	const file = settingsPath();
	const pos = positionals(args, ["--stack", "--hubs", "--env-file", "--plist"]);
	try {
		switch (sub) {
			case "get": {
				if (!pos[0]) break;
				const r = resolveSettings({ mode: "service", quiet: true });
				const v = getPath(r.settings, pos[0]);
				if (v === undefined) {
					io.err(`settings: no setting at ${pos[0]}\n`);
					return 1;
				}
				io.out(json(v));
				return 0;
			}
			case "set": {
				if (!pos[0] || pos[1] === undefined) break;
				const raw = loadRaw(file, io);
				return raw
					? writeDoc(file, setPath(raw, pos[0], parseValue(pos[1])), io)
					: 1;
			}
			case "unset": {
				if (!pos[0]) break;
				const raw = loadRaw(file, io);
				return raw ? writeDoc(file, unsetPath(raw, pos[0]), io) : 1;
			}
			case "validate": {
				const raw = loadRaw(file, io);
				if (!raw) return 1;
				const check = validateDoc(raw);
				if (check.ok) io.out(`settings: ${file} valid\n`);
				else
					io.err(
						`settings: ${file} invalid:\n  ${check.issues.join("\n  ")}\n`,
					);
				return check.ok ? 0 : 1;
			}
			case "show":
				return cmdShow(args, io);
			case "schema":
				if (args.includes("--write")) {
					const target = join(dirname(file), SCHEMA_FILE);
					atomicWrite0600(target, settingsJsonSchemaText());
					io.out(`settings: wrote ${target}\n`);
				} else io.out(settingsJsonSchemaText());
				return 0;
			case "migrate":
				return cmdMigrate(args, io);
			case "render-hub": {
				if (!pos[0]) break;
				const raw = loadRaw(file, io);
				if (!raw) return 1;
				const r = renderHubSettings(raw, pos[0]);
				if (!r.ok) {
					io.err(`settings: ${r.issues.join("\n  ")}\n`);
					return 1;
				}
				io.out(json(r.doc));
				return 0;
			}
			default:
				break;
		}
	} catch (e) {
		io.err(
			e instanceof SettingsError
				? `${e.message}\n`
				: `settings: ${String(e)}\n`,
		);
		return 1;
	}
	io.err(`${USAGE}\n`);
	return 2;
}
