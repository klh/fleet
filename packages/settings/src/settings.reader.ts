// settings.reader.ts — the ONE settings reader every fleet package imports.
// Precedence: schema defaults < settings.json < explicit mapped env var
// (transition only; each env hit logs once as deprecated with the path to
// set). Cached and frozen; reloaded when the file's mtime or the mapped env
// signature changes. Failure posture is the CALLER's: services
// (`mode: "service"`) fail closed on a malformed file; hooks/gates
// (`mode: "hook"`, the default — a gate must never brick a session) fall
// back to the last-known-good snapshot with a loud warning.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { coerceEnv, ENV_MAP, type EnvMapping } from "./settings.env-map.ts";
import { renderHubSettings } from "./settings.overlay.ts";
import {
	type Settings,
	type SettingAt,
	type SettingPath,
	SettingsSchema,
	settingsIssues,
} from "./settings.schema.ts";
import { type Doc, getPath, isPlainObject, setPath } from "./settings.tree.ts";

export type Origin = "default" | "file" | `env:${string}`;
export type ReadMode = "service" | "hook";

export interface Resolved {
	settings: Readonly<Settings>;
	/** The raw file document (what the operator wrote). */
	file: Doc;
	/** Mapped env overrides applied, path → env name. */
	env: ReadonlyMap<string, string>;
	path: string;
	/** Non-fatal problems (bad env values, last-known-good fallback). */
	warnings: string[];
}

export class SettingsError extends Error {
	constructor(
		readonly file: string,
		readonly issues: string[],
	) {
		super(`settings: ${file} is invalid:\n  ${issues.join("\n  ")}`);
	}
}

/** ~/.config/klh/settings.json; KLH_SETTINGS overrides (tests, hubs). */
export const settingsPath = (): string =>
	process.env.KLH_SETTINGS ??
	join(process.env.HOME ?? homedir(), ".config", "klh", "settings.json");

const lkgPath = (file: string): string =>
	join(dirname(file), "settings.lkg.json");

/** Expand a leading ~/ against HOME. */
export const expandHome = (p: string): string =>
	p === "~" || p.startsWith("~/")
		? join(process.env.HOME ?? homedir(), p.slice(1))
		: p;

/** Read + JSON.parse the file. null = absent. Throws on malformed JSON. */
export function readSettingsFile(file: string): Doc | null {
	if (!existsSync(file)) return null;
	const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!isPlainObject(raw))
		throw new SettingsError(file, ["<root>: not an object"]);
	return raw;
}

/** Validate a raw document; returns the defaults-filled value or the
 *  loud issue list. Hub overlays are checked post-merge too. */
export function validateDoc(
	doc: Doc,
): { ok: true; value: Settings } | { ok: false; issues: string[] } {
	const parsed = SettingsSchema.safeParse(doc);
	if (!parsed.success)
		return { ok: false, issues: settingsIssues(parsed.error) };
	const issues: string[] = [];
	for (const [label, hub] of Object.entries(parsed.data.hubs)) {
		if (!hub.settings) continue;
		const r = renderHubSettings(doc, label);
		if (!r.ok) issues.push(...r.issues);
	}
	return issues.length
		? { ok: false, issues }
		: { ok: true, value: parsed.data };
}

const warnedThisProcess = new Set<string>();

/** Log a deprecation once per process (stderr; a reader never writes
 *  anything for a deprecation — hooks stay side-effect free). */
export function warnDeprecated(key: string, message: string): void {
	if (warnedThisProcess.has(key)) return;
	warnedThisProcess.add(key);
	process.stderr.write(`settings: ${message}\n`);
}

/** Env-knob deprecations fire only once the install HAS a settings.json —
 *  before migration the env is still the only config, and the one nudge is
 *  the stack.json deprecation (`coord settings migrate`). */
const logDeprecation = (map: EnvMapping, file: string): void => {
	if (!existsSync(file)) return;
	warnDeprecated(
		map.env,
		`env ${map.env} is deprecated — set ${map.path} in ${file} (env still wins during the transition)`,
	);
};

/** Apply mapped env overrides to a raw document. */
function applyEnv(
	doc: Doc,
	file: string,
	warnings: string[],
	quiet: boolean,
): { doc: Doc; env: Map<string, string> } {
	let out = doc;
	const env = new Map<string, string>();
	for (const map of ENV_MAP) {
		const raw = process.env[map.env];
		if (raw === undefined || raw.trim() === "") continue;
		const value = coerceEnv(map, raw);
		if (value === undefined) {
			warnings.push(
				`env ${map.env}=${raw} is not a valid ${map.kind}; ignored`,
			);
			continue;
		}
		const trial = setPath(out, map.path, value);
		if (!SettingsSchema.safeParse(trial).success) {
			warnings.push(
				`env ${map.env}=${raw} is out of bounds for ${map.path}; ignored`,
			);
			continue;
		}
		out = trial;
		env.set(map.path, map.env);
		if (!quiet) logDeprecation(map, file);
	}
	return { doc: out, env };
}

const envSignature = (): string =>
	ENV_MAP.map((m) => `${m.env}=${process.env[m.env] ?? ""}`).join("\0");

let cache: { key: string; resolved: Resolved } | null = null;

const deepFreeze = <T>(v: T): T => {
	if (typeof v === "object" && v !== null) {
		for (const child of Object.values(v)) deepFreeze(child);
		Object.freeze(v);
	}
	return v;
};

/** Resolve settings from disk + env. See the file header for posture. */
export function resolveSettings(
	opts: { mode?: ReadMode; file?: string; quiet?: boolean } = {},
): Resolved {
	const file = opts.file ?? settingsPath();
	const mode = opts.mode ?? "hook";
	let mtime = 0;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {}
	const key = `${file}\0${mtime}\0${mode}\0${envSignature()}`;
	if (cache?.key === key) return cache.resolved;
	const warnings: string[] = [];
	let fileDoc: Doc = {};
	try {
		fileDoc = readSettingsFile(file) ?? {};
		const check = validateDoc(fileDoc);
		if (!check.ok) throw new SettingsError(file, check.issues);
		if (Object.keys(fileDoc).length)
			try {
				atomicWrite0600(lkgPath(file), `${JSON.stringify(fileDoc)}\n`);
			} catch {}
	} catch (err) {
		const issues = err instanceof SettingsError ? err.issues : [String(err)];
		if (mode === "service") throw new SettingsError(file, issues);
		const lkg = readSettingsFile(lkgPath(file));
		fileDoc = lkg && validateDoc(lkg).ok ? lkg : {};
		const msg = `settings: ${file} is invalid — using ${lkg ? "last-known-good" : "defaults"}: ${issues.join("; ")}`;
		warnings.push(msg);
		process.stderr.write(`${msg}\n`);
	}
	const applied = applyEnv(fileDoc, file, warnings, opts.quiet === true);
	const value = SettingsSchema.parse(applied.doc);
	const resolved: Resolved = {
		settings: deepFreeze(value),
		file: fileDoc,
		env: applied.env,
		path: file,
		warnings,
	};
	cache = { key, resolved };
	return resolved;
}

/** The typed, frozen, cached settings value. */
export const settings = (opts?: { mode?: ReadMode }): Readonly<Settings> =>
	resolveSettings(opts).settings;

/** One typed setting by dotted path. */
export function setting<P extends SettingPath>(
	path: P,
	opts?: { mode?: ReadMode },
): SettingAt<P> {
	return getPath(resolveSettings(opts).settings, path) as SettingAt<P>;
}

/** Where a resolved leaf came from. */
export function originOf(r: Resolved, path: string): Origin {
	const env = r.env.get(path);
	if (env) return `env:${env}`;
	return getPath(r.file, path) !== undefined ? "file" : "default";
}

/** Test seam: drop the cache (the reload key covers normal use). */
export function resetSettingsCache(): void {
	cache = null;
	warnedThisProcess.clear();
}
