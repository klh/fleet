import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const quietDefaults = {
	tui: "fullscreen",
	viewMode: "focus",
	verbose: false,
	showTurnDuration: false,
	spinnerTipsEnabled: false,
} as const;

export function applyQuietOutput(path: string): typeof quietDefaults {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat && !stat.isFile()) {
		throw new Error(
			"Settings must be a regular file; symlinks are not replaced.",
		);
	}
	const before = existsSync(path) ? readFileSync(path, "utf8") : null;
	const settings: unknown = before === null ? {} : JSON.parse(before);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Settings must be a JSON object.");
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.quiet-${process.pid}-${crypto.randomUUID()}`;
	try {
		writeFileSync(
			temp,
			`${JSON.stringify({ ...settings, ...quietDefaults }, null, 2)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		const current = existsSync(path) ? readFileSync(path, "utf8") : null;
		const currentStat = lstatSync(path, { throwIfNoEntry: false });
		if (current !== before || (currentStat && !currentStat.isFile())) {
			throw new Error(
				"Settings changed during the update; retry after the other writer finishes.",
			);
		}
		renameSync(temp, path);
		chmodSync(path, 0o600);
		return quietDefaults;
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

export function runQuietOutput(args: string[]): void {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: bun quiet-output.ts [--apply] [--settings <path>]\nWithout --apply, only display the current presentation settings.",
		);
		return;
	}
	let path = join(process.env.HOME ?? "", ".claude", "settings.json");
	let apply = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--apply") apply = true;
		else if (args[i] === "--settings" && args[i + 1]) path = args[++i];
		else throw new Error(`Unknown or incomplete option: ${args[i]}`);
	}
	if (apply) applyQuietOutput(path);
	const settings = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: {};
	console.log(
		JSON.stringify(
			Object.fromEntries(
				Object.keys(quietDefaults).map((key) => [key, settings[key] ?? null]),
			),
		),
	);
}

if (import.meta.main) runQuietOutput(process.argv.slice(2));
