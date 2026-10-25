// hooks/lib/fleet-loop/license-audit.ts — W828: the Fleet personal-use license perimeter,
// enforced. One pass, four faces: (1) walk the repo's bun-managed
// node_modules (the isolated .bun store, plus hoisted entries for other
// linkers) and classify every dependency license against the PERMISSIVE
// allowlist — copyleft and unknown/missing are violations; (2) verify the
// vendored third-party bundles keep their license banners; (3) record the
// swarm model-repo licenses (ids parsed from belt's registry) and flag the
// non-commercial-only ones; (4) carry the external adopt-protocol map
// (Chorus AGPL-3.0: zero code — patterns only; emdash Apache-2.0, superlite
// and best-of MIT: attribution required, patterns preferred). Writes the
// report json the W822 pulse reads and lands finding.license-audit.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── classification ───────────────────────────────────────────────

/** Owner allowlist (2026-10-19): free for personal non-commercial use.
 *  MPL/EUPL are deliberately NOT here — the owner enumerated the list. */
export const PERMISSIVE = [
	"MIT",
	"ISC",
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"CC0-1.0",
	"Unlicense",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"BSD-4-Clause",
	"Unicode-3.0",
] as const;

/** The copyleft buckets the owner named: GPL/AGPL/LGPL/SSPL/BSL/elastic. */
const COPYLEFT_RE = /(GPL|SSPL|BSL-|Business Source License|Elastic)/i;

export type LicenseClass = "permissive" | "copyleft" | "unknown";

/** Classify one package.json license expression. SPDX `OR` duals resolve
 *  permissive when ANY branch is (we may take the permissive leg); `AND`
 *  needs every leg permissive. No field = unknown = violation. */
export function classifyLicense(raw: string | null | undefined): LicenseClass {
	const s = (raw ?? "").trim();
	if (s === "" || /^(SEE LICENSE|UNLICENSED|\(UNLICENSED\))/i.test(s))
		return "unknown";
	const legs = s.split(/\s+(?:AND|OR)\s+/i);
	const classes = legs.map((leg) => {
		const t = leg.trim();
		if (COPYLEFT_RE.test(t)) return "copyleft" as const;
		if (
			PERMISSIVE.some(
				(p) =>
					t.toUpperCase() === p.toUpperCase() ||
					t.toUpperCase().startsWith(p.toUpperCase()),
			)
		)
			return "permissive" as const;
		// retro/variant spellings: "MIT/X11", "*GPL w/ exceptions", LICENSE file refs
		if (/^MIT\b/i.test(t) || /^ISC\b/i.test(t)) return "permissive" as const;
		if (/^BSD/i.test(t)) return "permissive" as const;
		if (/^Apache/i.test(t)) return "permissive" as const;
		if (/^CC0/i.test(t)) return "permissive" as const;
		if (/^Unicode/i.test(t)) return "permissive" as const;
		return "unknown" as const;
	});
	if (/\s+OR\s+/i.test(s) && classes.includes("permissive"))
		return "permissive";
	if (classes.includes("copyleft")) return "copyleft";
	if (classes.every((c) => c === "permissive")) return "permissive";
	return "unknown";
}

// ─── node_modules walk ────────────────────────────────────────────

export interface LicenseRow {
	name: string;
	version: string;
	license: string;
	cls: LicenseClass;
	path: string;
}

export interface LicenseViolation {
	name: string;
	version: string;
	license: string;
	cls: LicenseClass;
	reason: string;
}

/** Stable key for acceptance tracking: name@version@license-class. */
export const violationKey = (v: LicenseViolation): string =>
	`${v.name}@${v.version}@${v.cls}`;

function readLicenseField(pkgJsonPath: string): string {
	try {
		const j = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
			license?: unknown;
			licenses?: unknown;
		};
		if (typeof j.license === "string") return j.license;
		if (Array.isArray(j.licenses))
			return j.licenses
				.map((l) => (typeof l === "string" ? l : (l as { type?: string }).type))
				.filter((l): l is string => typeof l === "string")
				.join(" AND ");
	} catch {
		/* unreadable package.json = unknown = flagged below */
	}
	return "";
}

/** One node_modules dir: every non-scoped entry is a package; scoped
 *  entries (@scope/name) descend one level. Symlinks are skipped here —
 *  the isolated store walk already owns them (dedupe stays exact). */
function walkNodeModules(
	nm: string,
	seen: Set<string>,
	rows: LicenseRow[],
	skip: string | null,
): void {
	let entries: string[];
	try {
		entries = readdirSync(nm);
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.startsWith(".") || e === skip || e === "node_modules") continue;
		if (e.startsWith("@")) {
			const scope = join(nm, e);
			if (!isRealDirectory(scope)) continue;
			let inner: string[];
			try {
				inner = readdirSync(scope);
			} catch {
				continue;
			}
			for (const n of inner) {
				if (n.startsWith(".")) continue;
				consider(join(scope, n), seen, rows);
			}
			continue;
		}
		consider(join(nm, e), seen, rows);
	}
}

function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function consider(full: string, seen: Set<string>, rows: LicenseRow[]): void {
	if (!isRealDirectory(full)) return;
	let j: { name?: string; version?: string };
	try {
		j = JSON.parse(readFileSync(join(full, "package.json"), "utf8")) as {
			name?: string;
			version?: string;
		};
	} catch {
		rows.push({
			name: full,
			version: "?",
			license: "",
			cls: "unknown",
			path: full,
		});
		return;
	}
	const name = j.name ?? full.split("/").pop() ?? full;
	const version = j.version ?? "?";
	const key = `${name}@${version}`;
	if (seen.has(key)) return;
	seen.add(key);
	const license = readLicenseField(join(full, "package.json"));
	rows.push({
		name,
		version,
		license: license === "" ? "(missing)" : license,
		cls: classifyLicense(license),
		path: full,
	});
}

/** Walk the repo's bun-managed node_modules: the isolated `.bun` store is
 *  the ground truth (every real package lives there exactly once); hoisted
 *  layouts (node_modules/<pkg>) are walked too, symlinks skipped, dedupe
 *  by name@version across both. */
export function walkLicenses(root: string): LicenseRow[] {
	const seen = new Set<string>();
	const rows: LicenseRow[] = [];
	const store = join(root, "node_modules", ".bun");
	if (existsSync(store)) {
		for (const d of readdirSync(store)) {
			if (d.startsWith(".")) continue;
			walkNodeModules(join(store, d, "node_modules"), seen, rows, null);
		}
	}
	walkNodeModules(join(root, "node_modules"), seen, rows, ".bun");
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export const violationsOf = (rows: LicenseRow[]): LicenseViolation[] =>
	rows
		.filter((r) => r.cls !== "permissive")
		.map((r) => ({
			name: r.name,
			version: r.version,
			license: r.license,
			cls: r.cls,
			reason:
				r.cls === "copyleft"
					? "copyleft license — Fleet license perimeter forbids bundled code"
					: "unknown/missing license field",
		}));

// ─── vendored third-party bundles ─────────────────────────────────

export interface VendoredEntry {
	/** repo-relative path of the vendored bundle */
	path: string;
	license: string;
	/** text that must appear in the file (the license banner marker) */
	marker: string;
}

/** Repo-relative vendor dir holding the hash-named board lit chunks. */
export const BOARD_VENDOR_DIR = "packages/suspenders/hooks/board-html/vendor";

/** The committed third-party bundles. First-party compiled chunks that
 *  happen to live in vendor/ dirs (klh-*.js, usage-panels.js) are NOT
 *  third-party — the root Fleet LICENSE covers them. */
export const VENDORED: VendoredEntry[] = [
	{
		path: "packages/belt/bin/vendor/lit.js",
		license: "BSD-3-Clause",
		marker: "Vendored from the Lit monorepo",
	},
	{
		path: "packages/local/bin/vendor/lit-shared.js",
		license: "BSD-3-Clause",
		marker: "Vendored from the Lit monorepo",
	},
	{
		path: "packages/suspenders/hooks/lib/vendor/skills-agents.ts",
		license: "MIT",
		marker: "vercel-labs/skills",
	},
	{
		// W858.10.2 committed the uPlot bundle but never perimeter-checked it —
		// admitted W1107.1.4 (the floor-8 gap its omission left behind).
		path: "packages/belt/bin/vendor/uPlot.iife.min.js",
		license: "MIT",
		marker: "uPlot v1.6.32",
	},
	{
		path: "packages/belt/bin/vendor/uPlot.min.css",
		license: "MIT",
		marker: "uPlot v1.6.32",
	},
];

/** The board lit chunks are content-hash named (lit-[hash].js — the names
 *  rotate every build), so the manifest cannot pin them: the pinned list
 *  rotted within one build (W1107.2.2 — it named lit-ztzmytvz.js, a chunk
 *  no build ever produced). Audit-time discovery instead: every lit-*.js in
 *  the vendor dir is third-party Lit runtime, banner-checked like the
 *  static bundles above. */
export function vendoredLitChunks(root: string): VendoredEntry[] {
	try {
		return readdirSync(join(root, BOARD_VENDOR_DIR))
			.filter((f) => /^lit-[^/]+\.js$/.test(f))
			.sort()
			.map((f) => ({
				path: `${BOARD_VENDOR_DIR}/${f}`,
				license: "BSD-3-Clause",
				marker: "Vendored from the Lit monorepo",
			}));
	} catch {
		return [];
	}
}

/** The audit set: static bundles + hash-named chunks discovered on disk. */
export function vendoredEntries(root: string): VendoredEntry[] {
	return [...VENDORED, ...vendoredLitChunks(root)];
}

export interface VendoredRow {
	path: string;
	license: string;
	header: "present" | "missing";
}

export function verifyVendorHeaders(
	root: string,
	vendored?: VendoredEntry[],
): VendoredRow[] {
	return (vendored ?? vendoredEntries(root)).map((v) => {
		let ok = false;
		try {
			ok =
				readFileSync(join(root, v.path), "utf8").includes(v.marker) &&
				readFileSync(join(root, v.path), "utf8").includes(v.license);
		} catch {
			ok = false;
		}
		return {
			path: v.path,
			license: v.license,
			header: ok ? "present" : "missing",
		};
	});
}

// ─── swarm model weights ──────────────────────────────────────────

export interface ModelRef {
	port: number;
	model: string;
}

/** Pull the port↔model pairs out of belt's registry source (the single
 *  source of truth — nothing here duplicates an id). */
export function parseModelIds(registryText: string): ModelRef[] {
	const out = new Map<number, string>();
	const re = /port:\s*(\d{4,5})|model:\s*"([^"]+)"/g;
	let lastPort = 0;
	let m: RegExpExecArray | null = re.exec(registryText);
	while (m !== null) {
		if (m[1]) lastPort = Number(m[1]);
		else if (m[2] && lastPort > 0) {
			out.set(lastPort, m[2]);
			lastPort = 0; // one model per port — a later model: without a new port: is a different table (e.g. AUDIO_SERVICES)
		}
		m = re.exec(registryText);
	}
	return [...out.entries()]
		.map(([port, model]) => ({ port, model }))
		.sort((a, b) => a.port - b.port);
}

export interface ModelLicenseRow {
	port: number;
	model: string;
	license: string;
	commercial: boolean | null;
	note: string;
}

/** Known license posture per swarm model. Qwen3 mainline = Apache-2.0; the
 *  Qwen3.5 generation + its trained checkpoints (kev-4b) carry the
 *  owner-asserted Qwen Research restrictions (non-commercial only).
 *  Recorded — NOT hard violations: review these before any commercial grant. */
export const MODEL_LICENSE_RULES: Array<{
	match: RegExp;
	license: string;
	commercial: boolean | null;
	note: string;
}> = [
	{
		match: /kev-4b/i,
		license: "Qwen-Research-family",
		commercial: false,
		note: "jaredpalmer checkpoint of Qwen/Qwen3.5-4B-Base — inherits base restrictions",
	},
	{
		match: /Qwen3\.5/i,
		license: "Qwen-Research-family",
		commercial: false,
		note: "owner-asserted research restrictions (2026-10-19) — verify on HF before any commercial step",
	},
	{
		match: /Qwen/i,
		license: "Apache-2.0",
		commercial: true,
		note: "Qwen3 mainline family",
	},
	{
		match: /./,
		license: "unknown",
		commercial: null,
		note: "unmapped HF id — record the license manually",
	},
];

export const modelLicenseOf = (
	model: string,
): Omit<ModelLicenseRow, "port" | "model"> => {
	const r = MODEL_LICENSE_RULES.find((x) => x.match.test(model));
	return {
		license: r?.license ?? "unknown",
		commercial: r?.commercial ?? null,
		note: r?.note ?? "unmapped HF id",
	};
};

export function modelLicenseRows(models: ModelRef[]): ModelLicenseRow[] {
	return models.map((m) => ({
		port: m.port,
		model: m.model,
		...modelLicenseOf(m.model),
	}));
}

// ─── external adopt-protocol map ──────────────────────────────────

export interface ExternalLicense {
	name: string;
	license: string;
	commercial: boolean;
	policy: string;
}

/** The owner adopt-protocol (2026-10-19): what may enter the tree from
 *  outside projects, and under what terms. */
export const EXTERNAL_SOURCES: ExternalLicense[] = [
	{
		name: "chorus",
		license: "AGPL-3.0",
		commercial: false,
		policy:
			"ZERO code may enter the tree — patterns/semantics only, no distinctive strings",
	},
	{
		name: "emdash",
		license: "Apache-2.0",
		commercial: true,
		policy: "copying allowed WITH attribution/NOTICE — prefer patterns",
	},
	{
		name: "superlite",
		license: "MIT",
		commercial: true,
		policy: "copying allowed WITH attribution/NOTICE — prefer patterns",
	},
	{
		name: "best-of",
		license: "MIT",
		commercial: true,
		policy: "copying allowed WITH attribution/NOTICE — prefer patterns",
	},
];

// ─── report ───────────────────────────────────────────────────────

export interface LicenseReport {
	at: number;
	repo: string;
	totals: {
		packages: number;
		allowlisted: number;
		violations: number;
		vendor: { present: number; total: number };
		models: { total: number; flagged: number };
	};
	violations: LicenseViolation[];
	vendored: VendoredRow[];
	models: ModelLicenseRow[];
	external: ExternalLicense[];
}

export interface LicenseAuditDeps {
	repo: string;
	walk?: typeof walkLicenses;
	vendor?: typeof verifyVendorHeaders;
	models?: () => ModelRef[];
	now?: () => number;
}

export function composeLicenseReport(deps: LicenseAuditDeps): LicenseReport {
	const rows = (deps.walk ?? walkLicenses)(deps.repo);
	const violations = violationsOf(rows);
	const vendored = (deps.vendor ?? verifyVendorHeaders)(deps.repo);
	const models = modelLicenseRows((deps.models ?? ((): ModelRef[] => []))());
	const flagged = models.filter((m) => m.commercial === false).length;
	return {
		at: (deps.now ?? Date.now)(),
		repo: deps.repo,
		totals: {
			packages: rows.length,
			allowlisted: rows.length - violations.length,
			violations: violations.length,
			vendor: {
				present: vendored.filter((v) => v.header === "present").length,
				total: vendored.length,
			},
			models: { total: models.length, flagged },
		},
		violations,
		vendored,
		models,
		external: EXTERNAL_SOURCES,
	};
}

// ─── artifact + pulse face ────────────────────────────────────────

export const licenseArtifactPath = (): string =>
	process.env.KLH_LICENSE_STATE ??
	join(homedir(), ".cache", "claude-governor", "license-audit.json");

/** Read the license report as the pulse's license-health lines; [] when
 *  absent/stale/corrupt (a dead audit never litters the digest forever).
 *  The headline line is decision-grade: packages, violations, vendor
 *  headers, flagged models, age. Violations ride as detail lines. */
export function readLicenseLines(
	nowMs = Date.now(),
	maxAgeMs = 8 * 86_400_000,
	path = licenseArtifactPath(),
): string[] {
	let r: LicenseReport;
	try {
		r = JSON.parse(readFileSync(path, "utf8")) as LicenseReport;
	} catch {
		return [];
	}
	if (typeof r.at !== "number" || nowMs - r.at > maxAgeMs) return [];
	const age = Math.max(0, Math.floor((nowMs - r.at) / 3_600_000));
	const lines = [
		`license-health: ${r.totals.packages} pkgs · ${r.totals.violations} violation(s) · vendored ${r.totals.vendor.present}/${r.totals.vendor.total} · models ${r.totals.models.flagged} flagged (${age}h old)`,
	];
	for (const v of r.violations.slice(0, 5))
		lines.push(
			`  license violation ${v.cls}: ${v.name}@${v.version} (${v.license})`,
		);
	return lines;
}

// ─── accepted-violations baseline ─────────────────────────────────

export const acceptedViolationsPath = (): string =>
	process.env.KLH_LICENSE_ACCEPTED ??
	join(homedir(), ".cache", "claude-governor", "license-accepted.json");

export function loadAccepted(path = acceptedViolationsPath()): Set<string> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((k): k is string => typeof k === "string"));
	} catch {
		return new Set();
	}
}

/** `--accept`: fold today's violations into the machine-local baseline. */
export function saveAccepted(
	keys: Set<string>,
	path = acceptedViolationsPath(),
): void {
	try {
		Bun.write(path, `${JSON.stringify([...keys].sort(), null, "\t")}\n`);
	} catch {
		/* unwritable baseline — the next fire re-flags; never fatal */
	}
}
