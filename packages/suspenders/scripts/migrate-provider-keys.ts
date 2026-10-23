#!/usr/bin/env bun
// scripts/migrate-provider-keys.ts — W1124.8.2.2 explicit ONE-TIME migration
// of upstream provider keys into the central machine stack.yaml
// (`~/.config/klh/stack.yaml`, mode 600 — config-over-code). Post-migration
// the central file is the canonical key source: profiles carry inline `key`,
// `env` stays a declared runtime binding, and there is NO implicit env or
// key-file fallback. Old sources (~/.claude/local-llm/*.env provider vars,
// the process environment, a declared key_file) are READ here and only here;
// this verb never deletes user files and never touches activation.
//
// Dry-run is the default and prints the plan with MASKED values only — raw
// key material never reaches stdout. --apply is explicit: 0600 backup of the
// whole file, atomic 0600 write, every other stack field preserved. A
// profile whose key resolves to several distinct values is ambiguous and
// refuses the whole apply unless --map names the source explicitly.
// Idempotent: profiles already carrying inline `key` are skipped, a run with
// nothing to write touches nothing.
//
// Usage:
//   bun scripts/migrate-provider-keys.ts                 # dry-run plan
//   bun scripts/migrate-provider-keys.ts --apply         # migrate
//   bun scripts/migrate-provider-keys.ts --map zai-coding=Z_AI_API_KEY \
//       --map zai-general=belt.env:Z_AI_API_KEY --apply  # explicit mapping
// Map values name the source: an env var NAME (any scanned source) or
// `file:VAR` (one specific env file).

import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
	maskSecret,
	parseEnvBody,
	PROVIDER_ENV_FILES,
	PROVIDER_KEY_RE,
} from "../hooks/lib/hub-provider-keys.ts";
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
} from "../hooks/lib/verb-kit.ts";

export const BACKUP_SUFFIX = ".pre-provider-migration";

export interface MigrationOptions {
	stackPath: string;
	localLlmHome: string;
	/** migrate for real; default is the dry-run plan */
	apply: boolean;
	/** explicit profile=source mapping (source: env NAME or file:VAR) */
	map: Record<string, string>;
	/** env files scanned for old key sources, in order */
	files?: readonly string[];
	/** process environment scan (tests inject; default process.env) */
	processEnv?: Record<string, string | undefined>;
}

export const KNOWN_PROFILES = ["zai-coding", "zai-general"] as const;

export interface ProfilePlan {
	profile: string;
	/** resolved raw value (never printed) or null */
	value: string | null;
	/** human-readable source label; masked value rides beside it */
	sources: { label: string; masked: string }[];
	/** inline key already present — nothing to do */
	existing: boolean;
	/** profile seen but sources disagree — apply refuses without --map */
	ambiguous: boolean;
	/** the --map override that pinned the source, if any */
	mappedFrom?: string;
	/** env var NAME the profile binds at runtime (unchanged by migration) */
	envBinding?: string;
}

export type MigrationPlan =
	| { ok: true; profiles: ProfilePlan[]; backup?: string }
	| { ok: false; reason: string };

/** One sighting of a key value: which file/env it came from. */
interface Sighting {
	label: string;
	value: string;
}

/** Scan the KNOWN OLD KEY SOURCES (env files + process env). Returns every
 *  provider-key var sighting; raw values stay in memory only. */
function collectSightings(opts: MigrationOptions): Sighting[] {
	const files = opts.files ?? PROVIDER_ENV_FILES;
	const out: Sighting[] = [];
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(join(opts.localLlmHome, f), "utf8");
		} catch {
			continue; // absent source file — nothing to migrate from it
		}
		for (const e of parseEnvBody(text)) {
			if (PROVIDER_KEY_RE.test(e.name))
				out.push({ label: `${f}:${e.name}`, value: e.value });
		}
	}
	for (const [name, value] of Object.entries(opts.processEnv ?? process.env)) {
		if (PROVIDER_KEY_RE.test(name) && value !== undefined)
			out.push({ label: `env:${name}`, value });
	}
	return out;
}

/** One --map entry: profile=source (env NAME or file:VAR). */
export function parseMapEntries(
	entries: readonly string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf("=");
		if (eq <= 0 || eq === entry.length - 1)
			throw new Error(
				`--map entries take profile=source (env NAME or file:VAR), got "${entry}"`,
			);
		out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
	}
	return out;
}

/** Plan one profile from its sightings (or an explicit --map pin). */
function planProfile(
	profile: string,
	sightings: Sighting[],
	mapSource: string | undefined,
): ProfilePlan {
	const plan: ProfilePlan = {
		profile,
		value: null,
		sources: [],
		existing: false,
		ambiguous: false,
	};
	if (mapSource !== undefined) {
		plan.mappedFrom = mapSource;
		planProfileMapped(plan, mapSource, sightings);
		return plan;
	}
	const distinct = new Map<string, Sighting>();
	for (const s of sightings)
		if (!distinct.has(s.value)) distinct.set(s.value, s);
	if (distinct.size === 1) plan.value = [...distinct.values()][0].value;
	if (distinct.size > 1) plan.ambiguous = true;
	plan.sources = sightings.map((s) => ({
		label: s.label,
		masked: maskSecret(s.value),
	}));
	return plan;
}

export interface ApplyOutcome {
	ok: boolean;
	reason?: string;
	backup?: string;
	written: string[];
}

/** Apply the plan: inline keys land on resolved profiles, every other stack
 *  field preserved verbatim (unknown fields + per-hub refs included). */
export function applyMigration(
	opts: MigrationOptions,
	plans: readonly ProfilePlan[],
	deps: { now?: () => Date; rename?: (a: string, b: string) => void } = {},
): ApplyOutcome {
	const blockers = applyBlockers(plans);
	if (blockers.length > 0)
		return { ok: false, reason: blockers.join("; "), written: [] };
	const loaded = loadProviders(opts.stackPath);
	if (!loaded.ok) return { ok: false, reason: loaded.reason, written: [] };
	const providers = loaded.providers;
	const written: string[] = [];
	for (const p of plans) {
		if (p.existing || p.value === null) continue;
		providers[p.profile] = { ...providers[p.profile], key: p.value };
		written.push(p.profile);
	}
	if (written.length === 0) return { ok: true, written };
	return writeMigrated(opts.stackPath, loaded.doc, providers, written, deps);
}

/** 0600 backup of the whole file + atomic 0600 write. Original intact on
 *  any failure; backup timestamped so repeated runs never clobber. */
function writeMigrated(
	stackPath: string,
	doc: Record<string, unknown>,
	providers: Record<string, Record<string, unknown>>,
	written: readonly string[],
	deps: { now?: () => Date; rename?: (a: string, b: string) => void },
): ApplyOutcome {
	mkdirSync(dirname(stackPath), { recursive: true, mode: 0o700 });
	const stamp = (deps.now ?? (() => new Date()))()
		.toISOString()
		.replace(/[:.]/g, "-");
	const backup = `${stackPath}${BACKUP_SUFFIX}.${stamp}`;
	try {
		copyFileSync(stackPath, backup);
		chmodSync(backup, 0o600);
	} catch {
		return { ok: false, reason: `backup write failed: ${backup}`, written: [] };
	}
	return writeMigratedAtomic(stackPath, doc, providers, written, backup, deps);
}

/** The atomic replace leg of writeMigrated. */
function writeMigratedAtomic(
	stackPath: string,
	doc: Record<string, unknown>,
	providers: Record<string, Record<string, unknown>>,
	written: readonly string[],
	backup: string,
	deps: { now?: () => Date; rename?: (a: string, b: string) => void },
): ApplyOutcome {
	const temporary = `${stackPath}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, stringify({ ...doc, providers }), { mode: 0o600 });
		(deps.rename ?? renameSync)(temporary, stackPath);
	} catch {
		rmSync(temporary, { force: true });
		return {
			ok: false,
			reason: "atomic stack write failed; original intact",
			written: [],
		};
	}
	return { ok: true, backup, written };
}

/** Dry-run render: masked sources per profile, never a raw value. */
export function renderPlan(plans: readonly ProfilePlan[]): string[] {
	const out: string[] = [];
	for (const p of plans) {
		if (p.existing) {
			out.push(`= ${p.profile}: inline key already present (skip)`);
			continue;
		}
		const src =
			p.sources.length === 0
				? "no source found"
				: p.sources.map((s) => `${s.label} (${s.masked})`).join(", ");
		const state = p.ambiguous ? "AMBIGUOUS" : "migrate";
		out.push(
			`${p.ambiguous ? "!" : "+"} ${p.profile}: ${state} — ${src}` +
				(p.envBinding === undefined ? "" : ` → binds env ${p.envBinding}`),
		);
	}
	return out;
}

const SPEC = defineVerb({
	name: "migrate-provider-keys",
	usage:
		"usage: bun scripts/migrate-provider-keys.ts [--apply] [--map profile=source]... [--stack <path>] [--home <path>]",
	switches: ["--apply"],
	flags: ["--map", "--stack", "--home"],
});

export function runMigration(argv: readonly string[]): number {
	const rest = [...argv];
	// --help anywhere wins before any parsing that could reject it (verb-kit
	// dispatch-tail convention: parseVerb dies on the unknown option first)
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const outcome = parseVerb(SPEC, rest);
	if (!outcome.ok) {
		console.error(`migrate-provider-keys: ${outcome.message}`);
		return 2;
	}
	const p = outcome.parsed;
	let map: Record<string, string>;
	try {
		map = parseMapEntries(p.all("--map"));
	} catch (e) {
		console.error(`migrate-provider-keys: ${(e as Error).message}`);
		return 2;
	}
	const home = p.flag("--home") ?? join(homedir(), ".claude", "local-llm");
	const opts: MigrationOptions = {
		stackPath:
			p.flag("--stack") ??
			process.env.KLH_STACK ??
			join(homedir(), ".config", "klh", "stack.yaml"),
		localLlmHome: home,
		apply: p.flag("--apply") === "true",
		map,
	};
	const planned = planMigration(opts);
	if (!planned.ok) {
		console.error(`migrate-provider-keys: ${planned.reason}`);
		return 2;
	}
	for (const line of renderPlan(planned.profiles)) console.log(line);
	return finishRun(opts, planned.profiles);
}

function finishRun(
	opts: MigrationOptions,
	plans: readonly ProfilePlan[],
): number {
	if (!opts.apply) {
		console.log("dry-run: re-run with --apply to write");
		return 0;
	}
	const result = applyMigration(opts, plans);
	if (!result.ok) {
		console.error(`migrate-provider-keys: ${result.reason}`);
		return 2;
	}
	if (result.backup !== undefined) console.log(`backup: ${result.backup}`);
	console.log(
		`migrated: ${result.written.length === 0 ? "nothing to do (already migrated)" : result.written.join(", ")}`,
	);
	return 0;
}

if (import.meta.main) process.exit(runMigration(process.argv.slice(2)));

/** Resolve a pinned --map source against the sightings; absent pin marks the
 *  plan ambiguous (apply refuses). */
function planProfileMapped(
	plan: ProfilePlan,
	mapSource: string,
	sightings: Sighting[],
): void {
	const colon = mapSource.indexOf(":");
	const wantFile = colon > 0 ? mapSource.slice(0, colon) : null;
	const wantVar = colon > 0 ? mapSource.slice(colon + 1) : mapSource;
	const hit = sightings.find(
		(s) =>
			s.value.length > 0 &&
			(wantFile === null
				? s.label.endsWith(`:${wantVar}`)
				: s.label === `${wantFile}:${wantVar}`),
	);
	if (hit === undefined) {
		plan.ambiguous = true; // pinned source absent — apply refuses
		return;
	}
	plan.value = hit.value;
	plan.sources.push({ label: hit.label, masked: maskSecret(hit.value) });
}

/** Load the stack doc, returning the providers table (empty when absent). */
function loadProviders(stackPath: string):
	| {
			ok: true;
			doc: Record<string, unknown>;
			providers: Record<string, Record<string, unknown>>;
	  }
	| { ok: false; reason: string } {
	let doc: Record<string, unknown>;
	try {
		doc = (parse(readFileSync(stackPath, "utf8")) ?? {}) as Record<
			string,
			unknown
		>;
	} catch {
		return { ok: false, reason: `unreadable stack file: ${stackPath}` };
	}
	const providers = (doc.providers ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	return { ok: true, doc, providers };
}

/** Build the full plan: profiles with an inline key are an idempotent skip;
 *  the rest resolve from scanned old sources (or a pinned --map). */
export function planMigration(opts: MigrationOptions): MigrationPlan {
	const loaded = loadProviders(opts.stackPath);
	if (!loaded.ok) return { ok: false, reason: loaded.reason };
	if (opts.apply && Object.keys(loaded.providers).length === 0)
		return {
			ok: false,
			reason: `no providers section in ${opts.stackPath} — add profile declarations first (see deploy/stack.example.yaml)`,
		};
	const sightings = collectSightings(opts);
	const plans: ProfilePlan[] = [];
	for (const [name, row] of Object.entries(loaded.providers)) {
		if (typeof row.key === "string" && row.key.length > 0) {
			plans.push({
				profile: name,
				value: null,
				sources: [],
				existing: true,
				ambiguous: false,
				...(typeof row.env === "string" ? { envBinding: row.env } : {}),
			});
			continue;
		}
		const p = planProfile(name, sightings, opts.map[name]);
		if (typeof row.env === "string") p.envBinding = row.env;
		plans.push(p);
	}
	return { ok: true, profiles: plans };
}

/** Any plan trait that must refuse --apply. */
export function applyBlockers(plans: readonly ProfilePlan[]): string[] {
	const out: string[] = [];
	for (const p of plans) {
		if (p.existing || p.value !== null) continue;
		out.push(
			p.ambiguous
				? `profile ${p.profile}: sources disagree or a pinned --map source is absent — pass --map ${p.profile}=<env|file:VAR>`
				: `profile ${p.profile}: no key found in any known old source`,
		);
	}
	return out;
}
