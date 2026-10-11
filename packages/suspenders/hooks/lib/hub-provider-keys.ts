// hooks/lib/hub-provider-keys.ts — W231 hub admin plane: the masked
// provider-key inventory. Upstream keys live ONLY in machine-level config
// (the sanctioned env homes: ~/.claude/local-llm/*.env and the process
// environment — enterprise-config law). This lens answers "which provider
// credentials does this hub hold, and do they look present" — masked tails
// (••••last4) only; raw material never leaves the process.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Env-var suffix that marks a credential as a provider key. Deliberately
 *  narrower than "*_KEY": the admin plane's own secrets (BUCKLE_ADMIN_KEY,
 *  LITELLM_KEY, hub tokens) are identity, not providers — they stay out of
 *  this listing. */
const PROVIDER_KEY_RE = /^[A-Z][A-Z0-9_]*_API_KEY$/;

/** The sanctioned env homes, in listing order. Absent files are skipped —
 *  a spoke without belt.env simply reports fewer sources. */
export const PROVIDER_ENV_FILES = [
	"belt.env",
	"buckle-spoke.env",
	"buckle-desktop.env",
] as const;

/** ••••last4 — anything shorter than 8 chars masks to a bare •••• (no
 *  length hint for tiny values). */
export function maskSecret(v: string): string {
	const s = v.trim();
	return s.length >= 8 ? `••••${s.slice(-4)}` : "••••";
}

export interface ProviderKeyRow {
	name: string;
	/** where the value was seen: "<file>.env" or "process env" */
	source: string;
	set: boolean;
	masked: string | null;
}

interface EnvEntry {
	name: string;
	value: string;
}

/** Parse a .env body into entries — comments/blank lines skipped; values
 *  may be quoted. Never throws on a malformed line (skips it). */
export function parseEnvBody(text: string): EnvEntry[] {
	const out: EnvEntry[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t.length === 0 || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const name = t.slice(0, eq).trim();
		let value = t.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.length === 0) continue;
		out.push({ name, value });
	}
	return out;
}

/** Machine config home for the env files (config-over-code; the same
 *  ~/.claude/local-llm home every belt/buckle surface resolves). */
export function providerConfigHome(
	env: { HOME?: string } = process.env,
): string {
	return join(env.HOME ?? homedir(), ".claude", "local-llm");
}

/** The masked inventory: per env name (file scan + process env), one row —
 *  file sources listed in PROVIDER_ENV_FILES order, then the live process
 *  environment. A name seen in several places lists each sighting. */
export function providerKeyInventory(
	opts: {
		home?: string;
		files?: readonly string[];
		processEnv?: Record<string, string | undefined>;
	} = {},
): ProviderKeyRow[] {
	const home = opts.home ?? providerConfigHome();
	const files = opts.files ?? PROVIDER_ENV_FILES;
	const rows: ProviderKeyRow[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		const p = join(home, f);
		let text: string;
		try {
			text = readFileSync(p, "utf8");
		} catch {
			continue; // absent home — the file simply is not there
		}
		for (const e of parseEnvBody(text)) {
			if (!PROVIDER_KEY_RE.test(e.name) || seen.has(`${f}:${e.name}`)) continue;
			seen.add(`${f}:${e.name}`);
			rows.push({
				name: e.name,
				source: f,
				set: true,
				masked: maskSecret(e.value),
			});
		}
	}
	for (const [name, value] of Object.entries(opts.processEnv ?? process.env)) {
		if (!PROVIDER_KEY_RE.test(name) || value === undefined) continue;
		if (seen.has(`env:${name}`)) continue;
		seen.add(`env:${name}`);
		rows.push({
			name,
			source: "process env",
			set: true,
			masked: maskSecret(value),
		});
	}
	return rows;
}

/** Dir listing helper kept for tests/diagnostics — the mtime of an env
 *  file (freshness hint for the GUI footer). Null when absent. */
export function envFileMtime(home: string, file: string): number | null {
	try {
		return statSync(join(home, file)).mtimeMs;
	} catch {
		return null;
	}
}

/** Names of the env files actually present under `home` (GUI provenance
 *  footer). Never throws. */
export function presentEnvFiles(home: string): string[] {
	try {
		return readdirSync(home).filter((f) => f.endsWith(".env"));
	} catch {
		return [];
	}
}
