#!/usr/bin/env bun
// scripts/install-services.ts — render fleet's custom bun runners from ONE
// declarative manifest (deploy/services.yaml, W488.1) into platform service
// units. Emitters: darwin/launchd plists (W488.1) · linux/systemd USER units
// + sibling timers (W488.2) · win32/WinSW v5 XML (W488.3).
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
//   --target   defaults to process.platform (darwin|linux|win32 all render).
//   --out      writes the per-target unit files (darwin com.suspenders.<name>.plist;
//              linux suspenders-<name>.service [+ .timer]; win32
//              suspenders-<name>.xml); without it units go to stdout
//              separated by comment banners (inspection mode).
//   --json     prints {"target","services":[{service,target,outFile,files}],"wallMs"}
//              where outFile is the primary unit path and files lists every
//              unit file name for the service (timers included).
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
	envFile?: string | string[];
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

function envFilePaths(spec: ServiceSpec): string[] {
	if (spec.envFile === undefined) return [];
	const paths = Array.isArray(spec.envFile) ? spec.envFile : [spec.envFile];
	if (
		paths.length === 0 ||
		paths.some(
			(path) =>
				typeof path !== "string" ||
				!/[/$~_]/.test(path) ||
				/[\0\r\n]/.test(path),
		)
	) {
		throw new Error(
			`service "${spec.name}": envFile must be a PATH reference or non-empty list of PATH references`,
		);
	}
	return paths;
}

// every placeholder the EMITTED unit will contain: __BUN__ is implicit (the
// emitter always prepends the bun binary as ProgramArguments[0])
export function usedPlaceholders(spec: ServiceSpec): string[] {
	const found = new Set<string>(["__BUN__"]);
	scanText(spec.bunEntry, found);
	if (spec.cwd !== undefined) scanText(spec.cwd, found);
	for (const path of envFilePaths(spec)) scanText(path, found);
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
	envFilePaths(spec);
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
		if (entry.envFile !== undefined)
			spec.envFile = entry.envFile as string | string[];
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

// shared post-render guard (all three emitters): a placeholder that survived
// substitution means a token nobody can resolve — fail loudly, never emit a
// half-rendered unit (the old sed pass silently shipped those).
function residualTokens(text: string): string[] {
	return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
}

function assertNoResidualTokens(name: string, text: string): void {
	const residual = residualTokens(text);
	if (residual.length > 0) {
		throw new Error(
			`service "${name}": unresolvable placeholder(s) in rendered unit: ${residual.join(" ")}`,
		);
	}
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
	const directArgs = [
		values.bun,
		s(spec.bunEntry),
		...spec.args.map((a) => s(a)),
	];
	const files = envFilePaths(spec).map(s);
	// launchd has no EnvironmentFile. Positional arguments keep machine
	// paths and service argv out of shell syntax; exec preserves supervision.
	const args =
		files.length === 0
			? directArgs
			: [
					"/bin/sh",
					"-c",
					["set -ae", ...files.map(() => '. "$1"; shift'), 'exec "$@"'].join(
						"; ",
					),
					`fleet-${spec.name}`,
					...files,
					...directArgs,
				];
	for (const arg of args) {
		body.push(`\t\t<string>${escXml(arg)}</string>\n`);
	}
	body.push("\t</array>\n");
	if (spec.cwd !== undefined)
		body.push(xmlStr("WorkingDirectory", s(spec.cwd), "\t"));
	const envKeys = Object.keys(spec.env);
	if (envKeys.length > 0) {
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
	assertNoResidualTokens(spec.name, unit);
	return unit;
}

// ---- linux/systemd (W488.2) ----
// launchd -> systemd USER units under ~/.config/systemd/user/. Mapping:
// KeepAlive -> Restart=always + RestartSec; interval/calendar -> sibling
// <unit>.timer (OnBootSec+OnUnitActiveSec or OnCalendar+Persistent);
// Nice/cwd/env -> Nice=/WorkingDirectory=/Environment=; envFile ->
// EnvironmentFile=<path>; logs -> StandardOutput/Error=append:<path>.

const UNIT_NS = "suspenders";
const SYSTEMD_DEFAULT_RESTART_SEC = 5;

// systemd ExecStart/Environment quoting: double-quoted, backslash-escaped,
// % doubled (specifier expansion would otherwise eat it).
function systemdQuote(s: string): string {
	const escaped = s
		.replaceAll("%", "%%")
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"');
	return `"${escaped}"`;
}

function calendarSpec(cal: { hour: number; minute: number }): string {
	const hh = String(cal.hour).padStart(2, "0");
	const mm = String(cal.minute).padStart(2, "0");
	return `*-*-* ${hh}:${mm}:00`;
}

function linuxUnitHeader(unitName: string, timerBacked: boolean): string[] {
	const activate = timerBacked ? `${unitName}.timer` : `${unitName}.service`;
	return [
		`# ${unitName}.service — rendered from deploy/services.yaml (W488.2).`,
		`# install: systemctl --user daemon-reload && systemctl --user enable --now ${activate}`,
		"# mapping: keepalive -> Restart=always + RestartSec; interval or",
		"# calendar -> sibling timer (OnBootSec/OnUnitActiveSec or OnCalendar",
		"# + Persistent); RunAtLoad -> enable --now (timer-backed units fire",
		"# first at OnBootSec — start once by hand to run now).",
	];
}

function linuxServiceSection(
	spec: ServiceSpec,
	values: RenderValues,
	timerBacked: boolean,
): string[] {
	const s = (t: string): string => substitute(t, values);
	const l: string[] = ["[Service]"];
	if (timerBacked) {
		l.push("Type=oneshot");
	} else if (spec.schedule.keepalive === true) {
		const restartSec =
			spec.schedule.throttleSeconds ?? SYSTEMD_DEFAULT_RESTART_SEC;
		l.push("Restart=always", `RestartSec=${restartSec}s`);
	}
	const argv = [values.bun, s(spec.bunEntry), ...spec.args.map((a) => s(a))];
	l.push(`ExecStart=${argv.map(systemdQuote).join(" ")}`);
	if (spec.cwd !== undefined) l.push(`WorkingDirectory=${s(spec.cwd)}`);
	if (spec.nice !== undefined) l.push(`Nice=${spec.nice}`);
	for (const [k, v] of Object.entries(spec.env)) {
		l.push(`Environment=${systemdQuote(`${k}=${s(v)}`)}`);
	}
	for (const path of envFilePaths(spec)) {
		l.push(`EnvironmentFile=${systemdQuote(s(path))}`);
	}
	l.push(`StandardOutput=append:${s(spec.logs.out)}`);
	l.push(`StandardError=append:${s(spec.logs.err)}`);
	return l;
}

export function renderLinux(spec: ServiceSpec, values: RenderValues): string {
	const unitName = `${UNIT_NS}-${spec.name}`;
	const timerBacked =
		spec.schedule.intervalSeconds !== undefined ||
		spec.schedule.calendar !== undefined;
	const unit = `${[
		...linuxUnitHeader(unitName, timerBacked),
		"[Unit]",
		`Description=fleet ${spec.name} (deploy/services.yaml)`,
		"After=network-online.target",
		"Wants=network-online.target",
		...linuxServiceSection(spec, values, timerBacked),
		"[Install]",
		"WantedBy=default.target",
	].join("\n")}\n`;
	assertNoResidualTokens(spec.name, unit);
	return unit;
}

function linuxTimerComment(spec: ServiceSpec, unitName: string): string[] {
	const interval = spec.schedule.intervalSeconds;
	if (interval !== undefined) {
		return [
			`# ${unitName}.timer — sibling of ${unitName}.service (W488.2).`,
			`# launchd intervalSeconds=${interval} -> OnBootSec (first fire, later`,
			"# than launchd's load-time run) + OnUnitActiveSec (the period).",
		];
	}
	return [
		`# ${unitName}.timer — sibling of ${unitName}.service (W488.2).`,
		"# launchd StartCalendarInterval -> OnCalendar + Persistent=true",
		"# (launchd coalesces missed calendar fires the same way).",
	];
}

export function renderLinuxTimer(spec: ServiceSpec): string | null {
	const interval = spec.schedule.intervalSeconds;
	const cal = spec.schedule.calendar;
	if (interval === undefined && cal === undefined) return null;
	const unitName = `${UNIT_NS}-${spec.name}`;
	const unit = `${[
		...linuxTimerComment(spec, unitName),
		"[Unit]",
		`Description=fleet ${spec.name} schedule (deploy/services.yaml)`,
		"[Timer]",
		...(interval !== undefined
			? [`OnBootSec=${interval}s`, `OnUnitActiveSec=${interval}s`]
			: []),
		...(cal !== undefined
			? [`OnCalendar=${calendarSpec(cal)}`, "Persistent=true"]
			: []),
		`Unit=${unitName}.service`,
		"[Install]",
		"WantedBy=timers.target",
	].join("\n")}\n`;
	assertNoResidualTokens(spec.name, unit);
	return unit;
}

export function renderTarget(
	target: string,
	spec: ServiceSpec,
	values: RenderValues,
): string {
	if (target === "darwin") return renderDarwin(spec, values);
	if (target === "linux") return renderLinux(spec, values);
	if (target === "win32") return renderWin32(spec, values);
	throw new Error(`unknown target "${target}" (darwin|linux|win32)`);
}

// every unit file a service renders to on this target (primary first —
// darwin the plist, linux the .service, win32 the .xml; timers follow).
export function renderUnits(
	target: string,
	spec: ServiceSpec,
	values: RenderValues,
): { file: string; body: string }[] {
	if (target === "darwin") {
		return [
			{
				file: `${LABEL_PREFIX}.${spec.name}.plist`,
				body: renderDarwin(spec, values),
			},
		];
	}
	if (target === "linux") {
		const unitName = `${UNIT_NS}-${spec.name}`;
		const units = [
			{ file: `${unitName}.service`, body: renderLinux(spec, values) },
		];
		const timer = renderLinuxTimer(spec);
		if (timer !== null) units.push({ file: `${unitName}.timer`, body: timer });
		return units;
	}
	if (target === "win32") {
		return [
			{
				file: `${UNIT_NS}-${spec.name}.xml`,
				body: renderWin32(spec, values),
			},
		];
	}
	throw new Error(`unknown target "${target}" (darwin|linux|win32)`);
}

// ---- win32 / WinSW v5 (W488.3) ----
// launchd -> WinSW mapping (ops doc: scripts/README-windows.md):
// KeepAlive -> <onfailure action="restart" delay="Ns"/> (a single element
// restarts on EVERY failure); interval/calendar -> WinSW has NO scheduler,
// the XML comment carries the exact schtasks /Create line; RunAtLoad ->
// <startmode>Automatic</startmode>; Nice -> <priority>; env values ride
// render-time substitution exactly as the launchd plist does; envFile is a
// PATH reference in a comment only — WinSW core has no envfile element and
// file contents are NEVER embedded; logs -> <logpath> + <log mode="roll"/>.

const WINSW_DEFAULT_DELAY_SEC = 5;

function escXmlAttr(s: string): string {
	return escXml(s).replaceAll('"', "&quot;");
}

// MSVC argv rules: double the backslashes before a quote, double a trailing
// backslash run (so the closing quote survives); quote only args that need it.
function winQuotedIfNeeded(s: string): string {
	const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
	return /\s/.test(s) ? `"${escaped}"` : s;
}

// launchd nice -> WinSW <priority> buckets.
function winPriority(nice: number): string {
	if (nice >= 15) return "idle";
	if (nice >= 5) return "belownormal";
	return "normal";
}

// manifest log paths are POSIX-shaped; real Windows renders substitute a
// native home so dirname must handle both separators.
function winDirname(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? "." : p.slice(0, i);
}

// Task Scheduler equivalent for interval/calendar services (WinSW has no
// scheduler of its own); rendered into the XML comment, never executed.
function schtasksHint(spec: ServiceSpec, values: RenderValues): string | null {
	const interval = spec.schedule.intervalSeconds;
	const cal = spec.schedule.calendar;
	if (interval === undefined && cal === undefined) return null;
	const argv = [
		values.bun,
		substitute(spec.bunEntry, values),
		...spec.args.map((a) => substitute(a, values)),
	];
	const cmd = argv.map(winQuotedIfNeeded).join(" ");
	if (interval !== undefined) {
		const minutes = Math.round(interval / 60);
		const note = interval % 60 === 0 ? "" : " (not minute-aligned)";
		return `schtasks /Create /SC MINUTE /MO ${minutes}${note} /TN ${UNIT_NS}-${spec.name} /TR "${cmd}"`;
	}
	const hh = String(cal.hour).padStart(2, "0");
	const mm = String(cal.minute).padStart(2, "0");
	return `schtasks /Create /SC DAILY /ST ${hh}:${mm} /TN ${UNIT_NS}-${spec.name} /TR "${cmd}"`;
}

function winComment(spec: ServiceSpec, values: RenderValues): string[] {
	const id = `${UNIT_NS}-${spec.name}`;
	const l: string[] = [
		"<!--",
		`  ${id}.xml — WinSW v5 config, rendered from deploy/services.yaml (W488.3).`,
		"  ops doc: scripts/README-windows.md (winsw install/start, NSSM",
		"  alternative, env-file injection without embedding secrets).",
	];
	const st = schtasksHint(spec, values);
	if (st !== null) {
		l.push(
			"  WinSW has no scheduler — Task Scheduler owns periodicity:",
			`    ${st}`,
		);
	}
	l.push(
		'  mapping: keepalive -> <onfailure action="restart"/>; RunAtLoad ->',
		"  <startmode>Automatic</startmode>; nice -> <priority>.",
	);
	return l;
}

function winIdentity(spec: ServiceSpec, values: RenderValues): string[] {
	const s = (t: string): string => substitute(t, values);
	const argv = [s(spec.bunEntry), ...spec.args.map((a) => s(a))];
	const l: string[] = [
		`  <executable>${escXml(values.bun)}</executable>`,
		`  <arguments>${escXml(argv.map(winQuotedIfNeeded).join(" "))}</arguments>`,
	];
	if (spec.cwd !== undefined) {
		l.push(`  <workingdirectory>${escXml(s(spec.cwd))}</workingdirectory>`);
	}
	return l;
}

function winRuntime(spec: ServiceSpec, values: RenderValues): string[] {
	const s = (t: string): string => substitute(t, values);
	const l: string[] = [];
	for (const [k, v] of Object.entries(spec.env)) {
		l.push(`  <env name="${escXmlAttr(k)}" value="${escXmlAttr(s(v))}"/>`);
	}
	for (const path of envFilePaths(spec)) {
		l.push(
			"  <!-- envFile PATH reference only — WinSW core has no envfile element;",
			"       inject per README-windows.md (contents NEVER embedded):",
			`       ${s(path)} -->`,
		);
	}
	l.push(`  <logpath>${escXml(winDirname(s(spec.logs.out)))}</logpath>`);
	l.push('  <log mode="roll"/>');
	if (spec.schedule.keepalive === true) {
		const delay = spec.schedule.throttleSeconds ?? WINSW_DEFAULT_DELAY_SEC;
		l.push(`  <onfailure action="restart" delay="${delay} sec"/>`);
	}
	if (spec.nice !== undefined) {
		l.push(`  <priority>${winPriority(spec.nice)}</priority>`);
	}
	l.push("  <startmode>Automatic</startmode>");
	l.push("  <stopparentprocessfirst>true</stopparentprocessfirst>");
	return l;
}

export function renderWin32(spec: ServiceSpec, values: RenderValues): string {
	const id = `${UNIT_NS}-${spec.name}`;
	const unit = `${[
		...winComment(spec, values),
		"-->",
		"<service>",
		`  <id>${id}</id>`,
		`  <name>${id}</name>`,
		`  <description>${escXml(`fleet ${spec.name} (deploy/services.yaml)`)}</description>`,
		...winIdentity(spec, values),
		...winRuntime(spec, values),
		"</service>",
	].join("\n")}\n`;
	assertNoResidualTokens(spec.name, unit);
	return unit;
}

// stdout inspection-mode banner: XML-comment style for plists and WinSW
// XML, INI comment style for systemd units.
function banner(target: string, file: string): string {
	if (target === "linux") return `\n# ==== ${file} ====\n`;
	return `\n<!-- ==== ${file} ==== -->\n`;
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
		units: renderUnits(target, spec, values),
	}));
	const wallMs = performance.now() - t0;
	const results: {
		service: string;
		target: string;
		outFile: string | null;
		files: string[];
	}[] = [];
	if (outDir !== null) {
		mkdirSync(outDir, { recursive: true });
		for (const r of rendered) {
			for (const u of r.units) {
				writeFileSync(join(resolve(outDir), u.file), u.body);
			}
			results.push({
				service: r.spec.name,
				target,
				outFile: join(resolve(outDir), r.units[0].file),
				files: r.units.map((u) => u.file),
			});
		}
	} else {
		for (const r of rendered) {
			for (const u of r.units) {
				process.stdout.write(banner(target, u.file));
				process.stdout.write(u.body);
			}
			results.push({
				service: r.spec.name,
				target,
				outFile: null,
				files: r.units.map((u) => u.file),
			});
		}
	}
	console.error(
		`render: ${rendered.length} service(s) in ${wallMs.toFixed(2)}ms (target ${target})`,
	);
	if (target === "linux") {
		for (const r of rendered) {
			const unitName = r.units[0].file.replace(/\.service$/, "");
			const activate = r.units.some((u) => u.file.endsWith(".timer"))
				? `${unitName}.timer`
				: `${unitName}.service`;
			console.error(
				`activate: systemctl --user daemon-reload && systemctl --user enable --now ${activate}`,
			);
		}
	}
	if (target === "win32") {
		for (const r of rendered) {
			console.error(
				`install: winsw install+start ${r.units[0].file} per scripts/README-windows.md`,
			);
		}
	}
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
