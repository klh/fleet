#!/usr/bin/env bun
// scripts/install-services.ts — render fleet's custom bun runners from ONE
// declarative manifest (deploy/services.yaml, W488.1) into platform service
// units. Today: darwin/launchd plists. linux (W488.2) and win32 (W488.3)
// emitters land as siblings; --target for those dies loudly, never renders
// half a unit.
//
// Placeholder contract — IDENTICAL to install.sh's sed pass today (W490.2
// cuts install.sh over to this emitter):
//   BUN token        absolute bun path (--bun, else Bun.which("bun"))
//   HOME token       user home (--home, else $HOME)
//   PREFIX token     installed harness prefix (--prefix, else
//                    $SUSPENDERS_PREFIX, else $HOME/.claude/hooks/suspenders)
//   REPO token       the suspenders package root (--repo, else derived from
//                    this file's location)
//   BELT_URL token   belt front for fleet-loop ($BELT_URL, else
//                    http://127.0.0.1:4100 — install.sh's default)
//   BELT_TOKEN token belt auth token ($BELT_TOKEN, else empty)
// (Written as prose here so the rendered-unit residual-placeholder check
// below can never trip on this file's own header.)
// Secrets are NEVER in the manifest or the emitted units: a service may
// declare an envFile PATH reference; secret VALUES ride process env at
// render time exactly as install.sh substitutes them today.
//
// Usage:
//   bun scripts/install-services.ts [--target darwin|linux|win32]
//       [--out <dir>] [--service <name>]... [--json]
//       [--bun <path>] [--home <path>] [--prefix <path>] [--repo <path>]
//   --target   defaults to process.platform; non-darwin dies (W488.2/3).
//   --out      writes com.suspenders.<name>.plist files; without it units
//              go to stdout separated by comment banners (inspection mode).
//   --json     prints {"target","services":[{service,target,outFile}],"wallMs"}.
//   The stderr timing line (render: N service(s) in X ms) is the benchmark
//   number for the root benchmarks.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export const PACKAGE_ROOT = resolve(import.meta.dir, "..");
export const MANIFEST_PATH = join(PACKAGE_ROOT, "deploy", "services.yaml");
export const TEMPLATE_DIR = join(PACKAGE_ROOT, "hooks", "launchd");
export const LABEL_PREFIX = "com.suspenders";

export interface Schedule {
	runAtLoad: boolean;
	keepalive?: boolean;
	intervalSeconds?: number;
	calendar?: { hour: number; minute: number };
	throttleSeconds?: number;
}

export interface ServiceSpec {
	name: string;
	bunEntry: string;
	args: string[];
	cwd?: string;
	env: Record<string, string>;
	envFile?: string;
	schedule: Schedule;
	nice?: number;
	logs: { out: string; err: string };
	placeholders: string[];
}

interface ManifestFile {
	labelPrefix: string;
	defaults?: { schedule?: Partial<Schedule> };
	services: unknown[];
}

export interface RenderValues {
	bun: string;
	home: string;
	prefix: string;
	repo: string;
	beltUrl: string;
	beltToken: string;
}

const PLACEHOLDER_VALUES: Record<string, (v: RenderValues) => string> = {
	__BUN__: (v) => v.bun,
	__HOME__: (v) => v.home,
	__PREFIX__: (v) => v.prefix,
	__REPO__: (v) => v.repo,
	__BELT_URL__: (v) => v.beltUrl,
	__BELT_TOKEN__: (v) => v.beltToken,
};

const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/g;
const KNOWN_SCHEDULE_KEYS = new Set([
	"runAtLoad",
	"keepalive",
	"intervalSeconds",
	"calendar",
	"throttleSeconds",
]);
const KNOWN_MANIFEST_KEYS = new Set(["labelPrefix", "defaults", "services"]);
const KNOWN_SERVICE_KEYS = new Set([
	"name",
	"bunEntry",
	"args",
	"cwd",
	"env",
	"envFile",
	"schedule",
	"nice",
	"logs",
	"placeholders",
]);

export function defaultRenderValues(
	overrides: Partial<RenderValues> = {},
): RenderValues {
	const home = overrides.home ?? process.env.HOME ?? "";
	return {
		bun: overrides.bun ?? Bun.which("bun") ?? "bun",
		home,
		prefix:
			overrides.prefix ??
			process.env.SUSPENDERS_PREFIX ??
			join(home, ".claude", "hooks", "suspenders"),
		repo: overrides.repo ?? PACKAGE_ROOT,
		beltUrl:
			overrides.beltUrl ?? process.env.BELT_URL ?? "http://127.0.0.1:4100",
		beltToken: overrides.beltToken ?? process.env.BELT_TOKEN ?? "",
	};
}

export function substitute(text: string, values: RenderValues): string {
	let out = text;
	for (const [token, pick] of Object.entries(PLACEHOLDER_VALUES)) {
		out = out.replaceAll(token, pick(values));
	}
	return out;
}

function scanText(text: string, into: Set<string>): void {
	for (const m of text.matchAll(PLACEHOLDER_RE)) into.add(m[0]);
}

// every placeholder the EMITTED unit will contain: __BUN__ is implicit (the
// emitter always prepends the bun binary as ProgramArguments[0])
export function usedPlaceholders(spec: ServiceSpec): string[] {
	const found = new Set<string>(["__BUN__"]);
	scanText(spec.bunEntry, found);
	if (spec.cwd !== undefined) scanText(spec.cwd, found);
	if (spec.envFile !== undefined) scanText(spec.envFile, found);
	for (const a of spec.args) scanText(a, found);
	for (const [k, v] of Object.entries(spec.env)) {
		scanText(k, found);
		scanText(v, found);
	}
	scanText(spec.logs.out, found);
	scanText(spec.logs.err, found);
	return [...found].sort();
}

export function validateSpec(spec: ServiceSpec): void {
	const problems: string[] = [];
	if (!/^[a-z0-9-]+$/.test(spec.name)) problems.push(`bad name "${spec.name}"`);
	if (typeof spec.bunEntry !== "string" || spec.bunEntry.length === 0) {
		problems.push("bunEntry must be a non-empty string");
	}
	if (spec.envFile !== undefined && !/[/$~_]/.test(spec.envFile)) {
		problems.push(`envFile must be a PATH reference (got "${spec.envFile}")`);
	}
	const cal = spec.schedule.calendar;
	if (cal !== undefined) {
		if (!Number.isInteger(cal.hour) || cal.hour < 0 || cal.hour > 23)
			problems.push("calendar.hour out of range");
		if (!Number.isInteger(cal.minute) || cal.minute < 0 || cal.minute > 59)
			problems.push("calendar.minute out of range");
	}
	if (
		spec.schedule.intervalSeconds !== undefined &&
		(!Number.isInteger(spec.schedule.intervalSeconds) ||
			spec.schedule.intervalSeconds <= 0)
	) {
		problems.push("intervalSeconds must be a positive integer");
	}
	const used = usedPlaceholders(spec);
	const declared = [...spec.placeholders].sort();
	const missing = used.filter((t) => !declared.includes(t));
	const extra = declared.filter((t) => !used.includes(t));
	if (missing.length > 0)
		problems.push(`placeholders used but not declared: ${missing.join(" ")}`);
	if (extra.length > 0)
		problems.push(`placeholders declared but never used: ${extra.join(" ")}`);
	if (problems.length > 0)
		throw new Error(`service "${spec.name}": ${problems.join("; ")}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadManifest(path = MANIFEST_PATH): ServiceSpec[] {
	const raw = parse(readFileSync(path, "utf8")) as ManifestFile;
	if (!isPlainObject(raw))
		throw new Error(`${path}: manifest must be a mapping`);
	for (const k of Object.keys(raw)) {
		if (!KNOWN_MANIFEST_KEYS.has(k))
			throw new Error(`${path}: unknown manifest key "${k}"`);
	}
	const labelPrefix = raw.labelPrefix;
	if (labelPrefix !== LABEL_PREFIX)
		throw new Error(`${path}: labelPrefix must be "${LABEL_PREFIX}"`);
	const defaults = raw.defaults?.schedule ?? {};
	for (const k of Object.keys(defaults)) {
		if (!KNOWN_SCHEDULE_KEYS.has(k))
			throw new Error(`${path}: unknown schedule key "${k}" in defaults`);
	}
	const out: ServiceSpec[] = [];
	for (const entry of raw.services) {
		if (!isPlainObject(entry))
			throw new Error(`${path}: every service must be a mapping`);
		for (const k of Object.keys(entry)) {
			if (!KNOWN_SERVICE_KEYS.has(k))
				throw new Error(`${path}: unknown service key "${k}"`);
		}
		const rawSchedule = (entry.schedule ?? {}) as Record<string, unknown>;
		for (const k of Object.keys(rawSchedule)) {
			if (!KNOWN_SCHEDULE_KEYS.has(k))
				throw new Error(
					`${path}: unknown schedule key "${k}" in service "${entry.name as string}"`,
				);
		}
		const env: Record<string, string> = {};
		if (entry.env !== undefined) {
			if (!isPlainObject(entry.env))
				throw new Error(`${path}: env must be a mapping`);
			for (const [k, v] of Object.entries(entry.env)) {
				if (typeof v !== "string")
					throw new Error(`${path}: env.${k} must be a string (quote it)`);
				env[k] = v;
			}
		}
		const rawLogs = (entry.logs ?? {}) as Record<string, unknown>;
		const logOut = rawLogs.out;
		if (typeof logOut !== "string" || logOut.length === 0)
			throw new Error(`${path}: logs.out is required`);
		const spec: ServiceSpec = {
			name: entry.name as string,
			bunEntry: entry.bunEntry as string,
			args: (entry.args ?? []) as string[],
			env,
			schedule: {
				runAtLoad: defaults.runAtLoad ?? false,
				...rawSchedule,
			} as Schedule,
			logs: { out: logOut, err: (rawLogs.err as string) ?? logOut },
			placeholders: (entry.placeholders ?? []) as string[],
		};
		if (entry.cwd !== undefined) spec.cwd = entry.cwd as string;
		if (entry.envFile !== undefined) spec.envFile = entry.envFile as string;
		if (entry.nice !== undefined) spec.nice = entry.nice as number;
		for (const a of spec.args) {
			if (typeof a !== "string")
				throw new Error(
					`${path}: args must all be strings (quote "${String(a)}")`,
				);
		}
		validateSpec(spec);
		out.push(spec);
	}
	if (out.length === 0)
		throw new Error(`${path}: manifest declares no services`);
	return out;
}

function escXml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function xmlStr(key: string, value: string, indent: string): string {
	return `${indent}<key>${key}</key>\n${indent}<string>${escXml(value)}</string>\n`;
}

function xmlInt(key: string, value: number, indent: string): string {
	return `${indent}<key>${key}</key>\n${indent}<integer>${value}</integer>\n`;
}

export function renderDarwin(spec: ServiceSpec, values: RenderValues): string {
	const s = (text: string): string => substitute(text, values);
	const body: string[] = [];
	body.push(xmlStr("Label", `${LABEL_PREFIX}.${spec.name}`, "\t"));
	body.push("\t<key>ProgramArguments</key>\n\t<array>\n");
	for (const arg of [
		values.bun,
		s(spec.bunEntry),
		...spec.args.map((a) => s(a)),
	]) {
		body.push(`\t\t<string>${escXml(arg)}</string>\n`);
	}
	body.push("\t</array>\n");
	if (spec.cwd !== undefined)
		body.push(xmlStr("WorkingDirectory", s(spec.cwd), "\t"));
	const envKeys = Object.keys(spec.env);
	if (envKeys.length > 0 || spec.envFile !== undefined) {
		body.push("\t<key>EnvironmentVariables</key>\n\t<dict>\n");
		for (const k of envKeys) body.push(xmlStr(k, s(spec.env[k]), "\t\t"));
		body.push("\t</dict>\n");
	}
	if (spec.schedule.intervalSeconds !== undefined) {
		body.push(xmlInt("StartInterval", spec.schedule.intervalSeconds, "\t"));
	}
	if (spec.schedule.calendar !== undefined) {
		body.push("\t<key>StartCalendarInterval</key>\n\t<dict>\n");
		body.push(xmlInt("Hour", spec.schedule.calendar.hour, "\t\t"));
		body.push(xmlInt("Minute", spec.schedule.calendar.minute, "\t\t"));
		body.push("\t</dict>\n");
	}
	if (spec.schedule.throttleSeconds !== undefined) {
		body.push(xmlInt("ThrottleInterval", spec.schedule.throttleSeconds, "\t"));
	}
	if (spec.schedule.keepalive === true)
		body.push("\t<key>KeepAlive</key>\n\t<true/>\n");
	if (spec.schedule.runAtLoad) body.push("\t<key>RunAtLoad</key>\n\t<true/>\n");
	if (spec.nice !== undefined) body.push(xmlInt("Nice", spec.nice, "\t"));
	body.push(xmlStr("StandardOutPath", s(spec.logs.out), "\t"));
	body.push(xmlStr("StandardErrorPath", s(spec.logs.err), "\t"));
	const unit = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${body.join("")}</dict></plist>\n`;
	const residual = [
		...new Set([...unit.matchAll(PLACEHOLDER_RE)].map((m) => m[0])),
	];
	if (residual.length > 0) {
		throw new Error(
			`service "${spec.name}": unresolvable placeholder(s) in rendered unit: ${residual.join(" ")}`,
		);
	}
	return unit;
}

export function renderTarget(
	target: string,
	spec: ServiceSpec,
	values: RenderValues,
): string {
	if (target === "darwin") return renderDarwin(spec, values);
	throw new Error(
		`target "${target}" is not yet implemented — this child (W488.1) ships darwin only; linux lands in W488.2, win32 in W488.3`,
	);
}

function die(msg: string): never {
	console.error(`install-services: ${msg}`);
	process.exit(2);
}

function main(argv: string[]): number {
	let target = process.platform;
	let outDir: string | null = null;
	let json = false;
	const only: string[] = [];
	const overrides: Partial<RenderValues> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = (flag: string): string => {
			const v = argv[i + 1];
			if (v === undefined) die(`flag ${flag} needs a value`);
			i += 1;
			return v;
		};
		if (a === "--target") target = val(a);
		else if (a === "--out") outDir = val(a);
		else if (a === "--json") json = true;
		else if (a === "--service") only.push(val(a));
		else if (a === "--bun") overrides.bun = val(a);
		else if (a === "--home") overrides.home = val(a);
		else if (a === "--prefix") overrides.prefix = val(a);
		else if (a === "--repo") overrides.repo = val(a);
		else die(`unknown flag "${a}"`);
	}
	if (target !== "darwin" && target !== "linux" && target !== "win32") {
		die(`unknown target "${target}" (darwin|linux|win32)`);
	}
	if (target !== "darwin") {
		die(
			`target "${target}" is not yet implemented — this child (W488.1) ships darwin only; linux lands in W488.2, win32 in W488.3`,
		);
	}
	const all = loadManifest();
	const specs =
		only.length > 0
			? only.map(
					(n) =>
						all.find((s) => s.name === n) ??
						die(
							`unknown service "${n}" (have: ${all.map((s) => s.name).join(" ")})`,
						),
				)
			: all;
	const values = defaultRenderValues(overrides);
	const t0 = performance.now();
	const rendered = specs.map((spec) => ({
		spec,
		unit: renderTarget(target, spec, values),
	}));
	const wallMs = performance.now() - t0;
	const results: { service: string; target: string; outFile: string | null }[] =
		[];
	if (outDir !== null) {
		mkdirSync(outDir, { recursive: true });
		for (const r of rendered) {
			const file = join(
				resolve(outDir),
				`${LABEL_PREFIX}.${r.spec.name}.plist`,
			);
			writeFileSync(file, r.unit);
			results.push({ service: r.spec.name, target, outFile: file });
		}
	} else {
		for (const r of rendered) {
			process.stdout.write(
				`\n<!-- ==== ${LABEL_PREFIX}.${r.spec.name}.plist ==== -->\n`,
			);
			process.stdout.write(r.unit);
			results.push({ service: r.spec.name, target, outFile: null });
		}
	}
	console.error(
		`render: ${rendered.length} service(s) in ${wallMs.toFixed(2)}ms (target ${target})`,
	);
	if (json) {
		console.log(
			JSON.stringify(
				{ target, services: results, wallMs: Number(wallMs.toFixed(2)) },
				null,
				"\t",
			),
		);
	}
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
