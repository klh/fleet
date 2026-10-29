// test/helpers.ts — full-TS helpers for the settings specs. Spec files stay
// annotation-free (W1294 spec-shape law: only imports + plain-JS test bodies
// there); every typed helper lives here.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Scratch HOME with `.config/klh/` created and the settings file path
 *  resolved. `clean()` removes the tree. */
export interface SettingsHome {
	home: string;
	confDir: string;
	/** `<confDir>/settings.json` (the KLH_SETTINGS target). */
	file: string;
	/** `<confDir>/settings.lkg.json`. */
	lkg: string;
	/** `<confDir>/settings.schema.json` (migrate drops the schema here). */
	schema: string;
	secretsDir: string;
	setFile(doc: unknown): void;
	writeRaw(text: string): void;
	clean(): void;
}

export function scratchSettingsHome(): SettingsHome {
	const home = mkdtempSync(join(tmpdir(), "klh-settings-e2e-home-"));
	const confDir = join(home, ".config", "klh");
	mkdirSync(confDir, { recursive: true });
	const file = join(confDir, "settings.json");
	const w = {
		home,
		confDir,
		file,
		lkg: join(confDir, "settings.lkg.json"),
		schema: join(confDir, settings_schema_name()),
		secretsDir: join(confDir, "secrets"),
		setFile(doc: unknown): void {
			writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
		},
		writeRaw(text: string): void {
			writeFileSync(file, text);
		},
		clean(): void {
			rmSync(home, { recursive: true, force: true });
		},
	};
	return w;
}

// Keep the schema file name in ONE place (the CLI copies it next to the
// settings file on migrate; the currency guard compares the tracked copy).
function settings_schema_name(): string {
	return "settings.schema.json";
}

/** Snapshot the env vars the specs touch (undefined-safe); `restore()`
 *  puts every var back exactly as found. */
const ENV_KEYS = [
	"HOME",
	"KLH_SETTINGS",
	"KLH_STACK",
	"SUSPENDERS_MAX_READ",
	"SUSPENDERS_MAX_MUTATION",
	"SUSPENDERS_STEER_MIN_INTERVAL_S",
	"SUSPENDERS_HUB_NAS_URL",
	"SUSPENDERS_HUBS_FILE",
	"SUSPENDERS_KEV_URL",
	"SUSPENDERS_MAINTENANCE",
	"LOG_LEVEL",
] as const;

export type EnvSnap = Record<string, string | undefined>;

export function envSnapshot(): EnvSnap {
	const snap: EnvSnap = {};
	for (const k of ENV_KEYS) snap[k] = process.env[k];
	return snap;
}

export function envRestore(snap: EnvSnap): void {
	for (const k of ENV_KEYS) {
		const v = snap[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

/** Swap process.stderr.write for a line collector; `restore()` puts the
 *  original back and returns what was captured. */
export interface StderrTap {
	lines: string[];
	restore(): string;
}

export function tapStderr(): StderrTap {
	const orig = process.stderr.write.bind(process.stderr);
	const lines: string[] = [];
	process.stderr.write = ((chunk: unknown): boolean => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		lines,
		restore(): string {
			process.stderr.write = orig;
			return lines.join("");
		},
	};
}

/** Read a file if present, else null. */
export function readIfPresent(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** In-memory CliIo for runSettingsCli. */
export function collectIo(): {
	out: (s: string) => void;
	err: (s: string) => void;
	outs: string[];
	errs: string[];
} {
	const outs: string[] = [];
	const errs: string[] = [];
	return {
		out: (s) => {
			outs.push(s);
		},
		err: (s) => {
			errs.push(s);
		},
		outs,
		errs,
	};
}

/** Fixture trio for the migrate round-trip (paths + one nas hub profile
 *  with an inline token and one candidate). */
export function writeMigrateFixtures(w: SettingsHome): {
	stack: string;
	hubs: string;
	env: string;
} {
	const stackPath = join(w.confDir, "stack.fixture.json");
	const hubsPath = join(w.confDir, "hubs.fixture.json");
	const envPath = join(w.confDir, "belt.fixture.env");
	const stack = {
		version: "3.3.3",
		hubs: {
			nas: {
				host: "kk@nas.example",
				url: "https://nas.example:4101",
				token: "tok-inline-123",
				candidates: ["https://nas-a.example:4101"],
			},
		},
	};
	writeFileSync(stackPath, `${JSON.stringify(stack, null, 2)}\n`);
	const registry = {
		nas: {
			candidates: ["https://nas-b.example:4101", "https://nas-a.example:4101"],
		},
	};
	writeFileSync(hubsPath, `${JSON.stringify(registry, null, 2)}\n`);
	writeFileSync(envPath, "SUSPENDERS_MAINTENANCE=0\n");
	return { stack: stackPath, hubs: hubsPath, env: envPath };
}

// .worktrees/.claude/.fleet hold nested lane checkouts + runtime state in the
// shared main checkout — never source of this tree
const KnobScanSkip = new Set([
	"node_modules",
	".git",
	"test-results",
	".worktrees",
	".claude",
	".fleet",
]);

/** Count direct `process.env.<KNOB>` reads for the mapped env-knob names,
 *  outside @klh/settings, decant, and test trees (the ratchet scanner). */
export function countKnobEnvSites(
	repoRoot: string,
	knobNames: Set<string>,
): { sites: number; offenders: Map<string, number> } {
	const srcDir = join(repoRoot, "packages", "settings", "src");
	const sites = { n: 0 };
	const offenders = new Map<string, number>();
	const walk = (dir: string): void => {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (KnobScanSkip.has(name)) continue;
			scanEntry(join(dir, name), knobNames, srcDir, sites, offenders);
		}
	};
	walk(repoRoot);
	return { sites: sites.n, offenders };
}

function scanEntry(
	p: string,
	knobNames: Set<string>,
	srcDir: string,
	sites: { n: number },
	offenders: Map<string, number>,
): void {
	let st = null;
	try {
		st = statSync(p);
	} catch {
		return;
	}
	if (st.isDirectory()) {
		let inner: string[] = [];
		try {
			inner = readdirSync(p);
		} catch {
			return;
		}
		for (const name of inner) {
			if (KnobScanSkip.has(name)) continue;
			scanEntry(join(p, name), knobNames, srcDir, sites, offenders);
		}
		return;
	}
	scanFile(p, knobNames, srcDir, sites, offenders);
}

function scanFile(
	p: string,
	knobNames: Set<string>,
	srcDir: string,
	sites: { n: number },
	offenders: Map<string, number>,
): void {
	if (!p.endsWith(".ts") || p.endsWith(".d.ts")) return;
	if (/(^|\/)(test|tests|e2e)\//.test(p)) return;
	if (p.endsWith(".test.ts") || p.endsWith(".e2e.ts") || p.endsWith(".spec.ts"))
		return;
	if (p.includes("/packages/decant/")) return;
	if (p.startsWith(srcDir)) return;
	let text = "";
	try {
		text = readFileSync(p, "utf8");
	} catch {
		return;
	}
	for (const mm of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) {
		const envName = mm[1] ?? "";
		if (!knobNames.has(envName)) continue;
		sites.n += 1;
		offenders.set(envName, (offenders.get(envName) ?? 0) + 1);
	}
}
