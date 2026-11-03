// tests/helpers/knob-registry.lib.ts — W2470.1 knob-registry guard lib.
// Repo-root re-export of the registry (same convention as
// fleet.import-graph.lib.ts) + the scanner, typed, OUT of the spec file
// (W1294 spec-shape law: specs are annotation-free; helpers carry types).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export {
	type KnobHome,
	type KnobHomeKind,
	knobHome,
	KNOB_FAMILY_PREFIXES,
	KNOB_REGISTRY,
} from "../../packages/settings/src/settings.knob-registry.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SKIP_DIR = new Set([
	"node_modules",
	".git",
	"test-results",
	".worktrees",
	".claude",
	".fleet",
]);

const isTestPath = (p: string): boolean =>
	/(^|\/)(test|tests|e2e|examples)\//.test(p) ||
	/\.(test|e2e|spec)\.ts$/.test(p);

/** Every production .ts file under packages/ (vendored decant except). */
export function prodTsFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (SKIP_DIR.has(name)) continue;
			const p = join(dir, name);
			let st = null;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".d.ts")) continue;
			if (isTestPath(p)) continue;
			if (p.startsWith(join(ROOT, "packages", "decant"))) continue;
			out.push(p);
		}
	};
	walk(join(ROOT, "packages"));
	return out;
}

/** Map knob name -> first prod file mentioning it (failure rendering).
 *  The registry file itself is excluded — its own prefix rows would be
 *  self-hits, and a registry cannot ratchet its own declaration list. */
export function scanKnobMentions(): Map<string, string> {
	const hits = new Map<string, string>();
	for (const p of prodTsFiles()) {
		if (p.endsWith(join("settings", "src", "settings.knob-registry.ts")))
			continue;
		let text = "";
		try {
			text = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/SUSPENDERS_[A-Z][A-Z0-9_]*[A-Z0-9]/g)) {
			if (!hits.has(m[0])) hits.set(m[0], p.slice(ROOT.length + 1));
		}
	}
	return hits;
}

/** SUSPENDERS_* keys inside launchd plist EnvironmentVariables dicts. */
export function plistEnvKnobs(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (SKIP_DIR.has(name)) continue;
			const p = join(dir, name);
			let st = null;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(p);
				continue;
			}
			scanPlist(p, found);
		}
	};
	walk(join(ROOT, "packages"));
	return found;
}

function scanPlist(p: string, found: string[]): void {
	if (!p.endsWith(".plist")) return;
	const text = readFileSync(p, "utf8");
	const dict = text.match(
		/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
	);
	for (const m of (dict?.[1] ?? "").matchAll(
		/<key>(SUSPENDERS_[A-Z0-9_]+)<\/key>/g,
	)) {
		found.push(`${p.slice(ROOT.length + 1)}: ${m[1]}`);
	}
}
