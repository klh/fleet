// hooks/lib/kernel-conf.ts — the kernel config helper (W1253, Amendment A):
// fleet config is JSON. JSON.parse is the ONE parser for every config read;
// every write is an atomic 0600 upsert (tmp sibling + rename). Readers keep
// both file NAMES (the .json law name first, the legacy .yaml name second) so
// a rolling deploy never bricks a hub: old code parses .json by extension,
// new code parses both names, and hubctl/install only ever write .json.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Parse a fleet config file's bytes — JSON only (the ONE parser). */
export function parseJsonConf(text: string): unknown {
	return JSON.parse(text) as unknown;
}

/** Read + parse a fleet config file. Throws on missing/malformed — the
 *  strict leg every machine-conf reader (stack, notify, effort) rides. */
export function readJsonConf(path: string): unknown {
	return parseJsonConf(readFileSync(path, "utf8"));
}

/** The legacy twin name of a config path (same dir, .yaml suffix). */
export const legacyNameOf = (path: string): string =>
	path.replace(/\.json$/i, ".yaml");

/** Read-both candidate list for a config law name: the .json name first,
 *  then the legacy .yaml sibling. Exists-filtered; empty when neither is on
 *  disk. */
export function confCandidates(path: string): string[] {
	return [path, legacyNameOf(path)].filter((p) => existsSync(p));
}

/** Read the first candidate that parses: the .json law name wins, the
 *  legacy .yaml name is honored only while the migrate step has not run —
 *  and only for JSON content (the ONE parser law has no yaml leg). */
export function readJsonConfEither(path: string): unknown {
	const paths = confCandidates(path);
	if (paths.length === 0) throw new Error(`config not found: ${path}`);
	let last: unknown = new Error(`config not found: ${path}`);
	for (const p of paths) {
		try {
			return parseJsonConf(readFileSync(p, "utf8"));
		} catch (error) {
			last = error;
		}
	}
	throw last;
}

/** Atomic 0600 JSON write: serialize → tmp sibling (0600) → rename over the
 *  target. mkdir -p on the parent (first conf write on a fresh device). */
export function writeJsonConf(
	path: string,
	value: unknown,
	mode: number = 0o600,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode });
	renameSync(tmp, path);
}

/** Parse the legacy yaml bytes — MIGRATION-ONLY (the one yaml-parse leg the
 *  fleet keeps; config reads never touch it). Bun.YAML is builtin, so the
 *  yaml dependency leaves package.json entirely. */
function parseLegacyYaml(text: string): unknown {
	return Bun.YAML.parse(text) as unknown;
}

/** One-time machine-conf migration (W1253 Amendment A): parse the legacy
 *  yaml, write the .json law name 0600 atomically, move the original to
 *  .bak verbatim. Idempotent: json present → "kept"; neither on disk →
 *  "absent". The install migrate step calls this once per conf file. */
export function migrateYamlConf(
	yamlPath: string,
	jsonPath: string,
): "migrated" | "kept" | "absent" {
	if (existsSync(jsonPath)) return "kept";
	if (!existsSync(yamlPath)) return "absent";
	const st = statSync(yamlPath);
	if ((st.mode & 0o777) !== 0o600) {
		throw new Error(
			`migrate: ${yamlPath} must be mode 600 (got ${(st.mode & 0o777).toString(8)})`,
		);
	}
	const json = parseLegacyYaml(readFileSync(yamlPath, "utf8"));
	writeJsonConf(jsonPath, json);
	renameSync(yamlPath, `${yamlPath}.bak`);
	return "migrated";
}
