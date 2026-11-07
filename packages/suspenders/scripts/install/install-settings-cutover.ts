// scripts/install/install-settings-cutover.ts — W2582: the install's
// settings.json cutover leg. A stack.json with NO settings.json beside it
// migrates NOW (the install never leaves a partial settings.json shadowing
// a fuller stack.json); the yaml→json legs in install-conf-migrate run
// first so the .json law name is the input. An EXISTING settings.json that
// would mask un-migrated stack sections refuses loudly — the operator
// resolves it once via `coord settings migrate`; a stack.json fully
// covered by the settings document (or absent) is a no-op.
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FOLD_INTO_FLEET_LOOP, migrate } from "@klh/settings";

export interface CutoverResult {
	status: "ok" | "failed";
	note: string;
}

/** Atomic 0600 write (wx — never clobber). */
function writeFile0600(path: string, content: string): void {
	const temporary = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

export function cutOverSettings(home: string): CutoverResult {
	const confDir = join(home, ".config", "klh");
	const stackPath = join(confDir, "stack.json");
	const settingsFile = join(confDir, "settings.json");
	const hasStack = existsSync(stackPath);
	const hasSettings = existsSync(settingsFile);
	if (!hasStack && !hasSettings)
		return { status: "ok", note: "no machine conf — nothing to cut over" };
	if (!hasStack)
		return { status: "ok", note: "settings.json only (already cut over)" };
	let stack: Record<string, unknown> = {};
	try {
		stack = JSON.parse(readFileSync(stackPath, "utf8"));
	} catch (error) {
		return {
			status: "failed",
			note: `stack.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	// W2582 defect 1 guard: an existing settings.json that would MASK
	// stack sections (present in stack.json, absent in settings.json)
	// refuses — the incident's silent-masking shape never lands again.
	if (hasSettings) {
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(readFileSync(settingsFile, "utf8"));
		} catch (error) {
			return {
				status: "failed",
				note: `settings.json unreadable: ${error instanceof Error ? error.message : String(error)} — resolve via \`coord settings migrate\``,
			};
		}
		const masked = Object.keys(stack).filter((key) => {
			if (key === "hubs" || key === "token") return false;
			if (stack[key] === undefined) return false;
			if (existing[key] !== undefined) return false;
			// a key that FOLDS is covered when fleet_loop carries the
			// canonical knob (the migrate() fold already put it there)
			const folds = FOLD_INTO_FLEET_LOOP[key];
			if (
				folds &&
				typeof existing.fleet_loop === "object" &&
				existing.fleet_loop
			)
				return (
					(existing.fleet_loop as Record<string, unknown>)[folds] === undefined
				);
			return true;
		});
		if (masked.length > 0)
			return {
				status: "failed",
				note: `settings.json would mask stack.json sections (${masked.join(", ")}) — run \`coord settings migrate\` to fold them in, then reinstall`,
			};
		return { status: "ok", note: "settings.json covers the stack document" };
	}
	const res = migrate({ stack, secretsDir: join(confDir, "secrets") });
	if (res.issues.length)
		return {
			status: "failed",
			note: `settings migration refused: ${res.issues.join("; ")}`,
		};
	for (const [path, content] of Object.entries(res.secrets))
		writeFile0600(path, content);
	writeFile0600(settingsFile, `${JSON.stringify(res.doc, null, 2)}\n`);
	return {
		status: "ok",
		note: `stack.json → settings.json cut over (${res.report.length} report line(s)); stack.json kept as read-compat fallback`,
	};
}
