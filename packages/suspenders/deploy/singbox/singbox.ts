// deploy/singbox/singbox.ts — W1233: per-process TUN egress enforcement on
// muramasa. sing-box = the network-layer enforcement/audit hop (bytes flow
// through muramasa's TUN); buckle (W1230) stays the inference-layer gateway
// for Claude Desktop; ChatGPT keeps its OpenAI-bound TLS — the hub-relay
// http outbound is a FORWARD proxy that relays the app's TLS to its real
// destination, never a wire translation. Config-over-code: the real sing-box
// config lives in machine conf (~/.config/klh/singbox.json); this kit owns
// the fleet LAW for that config, a one-time seed from the repo template, and
// the acceptance verifier that reads sing-box's clash API for live
// per-process attribution.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { runCli } from "../../hooks/lib/verb-kit.ts";
import type { Parsed } from "../../hooks/lib/verb-kit.ts";

/** The one hub-bound outbound tag the fleet law names. */
const HUB_TAG = "hub-relay";
const DIRECT_TAG = "direct";
const BLOCK_TAG = "block";

/** The watched app bundles — representative binary paths the watched
 *  regexes MUST match; the claude CLI representative is what the regexes
 *  must NOT swallow (CLI exclusion is a regex choice, reported not forced). */
const WATCHED_APPS = [
	{
		app: "Claude.app",
		binary: "/Applications/Claude.app/Contents/MacOS/Claude",
	},
	{
		app: "ChatGPT.app",
		binary: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
	},
] as const;

/** Machine conf default: KLH_SINGBOX_CONF > ~/.config/klh/singbox.json.
 *  An empty-string env counts as unset (empty-string-env-is-set lesson). */
export const defaultConfPath = (): string => {
	const override = process.env.KLH_SINGBOX_CONF;
	if (override) return override;
	return join(homedir(), ".config", "klh", "singbox.json");
};

/** The repo template — the fleet-law reference shape with placeholders. */
export const templatePath = (): string =>
	join(import.meta.dir, "config.template.json");

const PORT_MIN = 1;
const PORT_MAX = 65535;

// — narrow helpers (no non-null, no any) —
const objOf = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;

const arrOf = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

const strOf = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

const numOf = (v: unknown): number | null =>
	typeof v === "number" && Number.isSafeInteger(v) ? v : null;

/** The claude CLI representative — homedir-anchored at runtime so the scrub
 *  law (/Users/<user> literals) never trips on this file. */
export const cliRepresentative = (): string =>
	join(homedir(), ".claude", "local", "claude");

/** Every `<...>` placeholder still standing in the tree — the machine conf
 *  must be real hosts/keys (config-over-code); a placeholder = not runnable. */
export function unfilledPlaceholders(node: unknown, path = "$"): string[] {
	const found: string[] = [];
	const obj = objOf(node);
	if (obj !== null) {
		for (const [k, v] of Object.entries(obj)) {
			found.push(...walkPlaceholder(v, `${path}.${k}`));
		}
		return found;
	}
	const arr = arrOf(node);
	if (arr !== null) {
		for (const [i, v] of arr.entries()) {
			found.push(...walkPlaceholder(v, `${path}[${i}]`));
		}
	}
	return found;
}

const walkPlaceholder = (v: unknown, path: string): string[] => {
	const s = strOf(v);
	if (s !== null) return s.startsWith("<") ? [`${path} = ${s}`] : [];
	return unfilledPlaceholders(v, path);
};

/** Parse a sing-box config from disk (JSON only — the fleet never ships
 *  YAML). Throws with the path on unparseable bytes or a non-object root. */
export function readConf(path: string): Record<string, unknown> {
	if (!isAbsolute(path)) throw new Error(`conf path must be absolute: ${path}`);
	const text = readFileSync(path, "utf8");
	try {
		const parsed: unknown = JSON.parse(text);
		const obj = objOf(parsed);
		if (obj === null) throw new Error("config root must be a JSON object");
		return obj;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`${path}: ${msg}`);
	}
}

/** TUN inbound law: exactly one, kernel-level capture engaged. */
export function lawTun(root: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const inbounds = arrOf(root.inbounds) ?? [];
	const tuns = inbounds
		.map(objOf)
		.filter(
			(o): o is Record<string, unknown> => o !== null && o.type === "tun",
		);
	if (tuns.length !== 1)
		problems.push(
			`inbounds: exactly one tun inbound required (found ${tuns.length})`,
		);
	const tun = tuns[0];
	if (tun === undefined) return problems;
	if (tun.auto_route !== true)
		problems.push(
			"tun.auto_route must be true — enforcement is kernel-level capture",
		);
	if (tun.strict_route !== true)
		problems.push("tun.strict_route must be true — no bypass routing");
	const addr = arrOf(tun.address) ?? [];
	if (addr.length === 0)
		problems.push("tun.address must list the TUN addresses");
	return problems;
}

/** The declared clash API endpoint (null when absent/malformed). The
 *  attribution verifier rides this; loopback binding is the law. */
export function clashApiOf(
	root: Record<string, unknown>,
): { controller: string; port: number; secret: string } | null {
	const exp = objOf(root.experimental);
	const clash = exp === null ? null : objOf(exp.clash_api);
	if (clash === null) return null;
	const ctrl = strOf(clash.external_controller);
	if (ctrl === null) return null;
	const m = /^127\.0\.0\.1:(\d+)$/.exec(ctrl);
	const port = m === null ? null : numOf(Number(m[1]));
	if (port === null || port < PORT_MIN || port > PORT_MAX) return null;
	const secret = strOf(clash.secret);
	return { controller: ctrl, port, secret: secret ?? "" };
}

/** Outbound law: exactly one hub-relay forward proxy (http|socks), plus the
 *  direct and block tags the route table names. */
export function lawOutbounds(root: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const outbounds = (arrOf(root.outbounds) ?? []).map(objOf);
	const hubs = outbounds.filter(
		(o): o is Record<string, unknown> => o !== null && o.tag === HUB_TAG,
	);
	if (hubs.length !== 1)
		problems.push(
			`outbounds: exactly one ${HUB_TAG} outbound required (found ${hubs.length})`,
		);
	const hub = hubs[0];
	if (hub === undefined) return problems;
	return hubProblems(hub, outbounds);
}

/** The hub outbound + tag-set laws, split for the mutation cap. */
const hubProblems = (
	hub: Record<string, unknown>,
	outbounds: (Record<string, unknown> | null)[],
): string[] => {
	const problems: string[] = [];
	const type = strOf(hub.type);
	if (type !== "http" && type !== "socks")
		problems.push(
			`${HUB_TAG}.type must be http|socks — a FORWARD proxy relaying the app's TLS, never a wire translation`,
		);
	const server = strOf(hub.server);
	if (server === null || server.startsWith("<"))
		problems.push(`${HUB_TAG}.server must be the real relay host`);
	const port = numOf(hub.server_port);
	if (port === null || port < PORT_MIN || port > PORT_MAX)
		problems.push(
			`${HUB_TAG}.server_port must be an integer ${PORT_MIN}-${PORT_MAX}`,
		);
	const tags = new Set(
		outbounds
			.filter((o): o is Record<string, unknown> => o !== null)
			.map((o) => (typeof o.tag === "string" ? o.tag : "")),
	);
	if (!tags.has(DIRECT_TAG))
		problems.push(`outbounds: a ${DIRECT_TAG} outbound is required`);
	if (!tags.has(BLOCK_TAG))
		problems.push(`outbounds: a ${BLOCK_TAG} outbound is required`);
	return problems;
};

/** The hub-bound process_path_regex rules — the watched set. */
export function watchedRulesOf(
	root: Record<string, unknown>,
): { regex: string; compiled: RegExp }[] {
	const route = objOf(root.route);
	const rules = arrOf(route === null ? null : route.rules) ?? [];
	const out: { regex: string; compiled: RegExp }[] = [];
	for (const r of rules.map(objOf)) {
		if (r === null) continue;
		const rx = strOf(r.process_path_regex);
		if (rx === null || r.outbound !== HUB_TAG) continue;
		try {
			out.push({ regex: rx, compiled: new RegExp(rx) });
		} catch {
			// invalid regex — reported by lawRoute
		}
	}
	return out;
}

/** Route law: catch-all stays direct (per-process enforcement, never
 *  global), watched regexes cover both app bundles, a DNS hijack keeps
 *  plain-DNS from leaking past the TUN, and interface auto-detect is on. */
export function lawRoute(root: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const route = objOf(root.route);
	if (route === null) return ["route: object required"];
	if (route.final !== DIRECT_TAG)
		problems.push(
			"route.final must be direct — the catch-all never hub-routes",
		);
	if (route.auto_detect_interface !== true)
		problems.push("route.auto_detect_interface must be true (TUN stability)");
	const rules = arrOf(route.rules) ?? [];
	const objs = rules
		.map(objOf)
		.filter((o): o is Record<string, unknown> => o !== null);
	const hijack = objs.some(
		(r) => r.protocol === "dns" && r.action === "hijack-dns",
	);
	if (!hijack)
		problems.push(
			"route.rules: a {protocol: dns, action: hijack-dns} rule is required",
		);
	const watched = watchedRulesOf(root);
	const declared = objs.filter((r) => "process_path_regex" in r).length;
	if (watched.length !== declared)
		problems.push("route.rules: a process_path_regex failed to compile");
	for (const app of WATCHED_APPS) {
		if (!watched.some((w) => w.compiled.test(app.binary)))
			problems.push(`route.rules: no hub-relay rule matches ${app.binary}`);
	}
	return problems;
}

/** The full fleet law for a sing-box enforcement config — every sub-law
 *  plus the clash API + placeholder walk. */
export function checkConfigLaw(root: Record<string, unknown>): string[] {
	const problems: string[] = [];
	if (objOf(root.log) === null) problems.push("log: object required");
	const dns = objOf(root.dns);
	if (dns === null || (arrOf(dns.servers) ?? []).length === 0)
		problems.push("dns: object with non-empty servers[] required");
	problems.push(...lawTun(root), ...lawOutbounds(root), ...lawRoute(root));
	if (clashApiOf(root) === null)
		problems.push(
			"experimental.clash_api.external_controller must be 127.0.0.1:<port>",
		);
	problems.push(
		...unfilledPlaceholders(root).map((p) => `placeholder unfilled: ${p}`),
	);
	return problems;
}

/** One live connection from the clash API /connections feed. sing-box's
 *  metadata key for the binary path moved between releases — read all
 *  three spellings. */
export interface ClashConnRow {
	id?: unknown;
	upload?: unknown;
	download?: unknown;
	chains?: unknown;
	metadata?: {
		processPath?: unknown;
		process_path?: unknown;
		process?: unknown;
		host?: unknown;
		destination?: unknown;
		destinationIP?: unknown;
	};
}

/** The binary path a connection is attributed to ("" when unknown). */
export function processPathOf(row: ClashConnRow): string {
	const m = row.metadata;
	if (m === undefined) return "";
	const first = strOf(m.processPath);
	if (first !== null) return first;
	const second = strOf(m.process_path);
	if (second !== null) return second;
	return strOf(m.process) ?? "";
}

/** Classify live rows against the watched set: hub egress (attributed),
 *  direct egress (LEAK — the enforcement hole), blocked, and everything
 *  else (unwatched processes riding direct by law). */
export function classifyConnections(
	rows: ClashConnRow[],
	watched: { compiled: RegExp }[],
): {
	hub: ClashConnRow[];
	leaks: ClashConnRow[];
	blocked: ClashConnRow[];
	rest: number;
} {
	const hub: ClashConnRow[] = [];
	const leaks: ClashConnRow[] = [];
	const blocked: ClashConnRow[] = [];
	let rest = 0;
	for (const row of rows) {
		const path = processPathOf(row);
		const isWatched = watched.some((w) => w.compiled.test(path));
		const tag = arrOf(row.chains)?.[0];
		if (!isWatched) {
			rest++;
			continue;
		}
		if (tag === HUB_TAG) hub.push(row);
		else if (tag === DIRECT_TAG) leaks.push(row);
		else if (tag === BLOCK_TAG) blocked.push(row);
		else leaks.push(row);
	}
	return { hub, leaks, blocked, rest };
}

/** GET /connections from the clash API (loopback, optional bearer). */
export async function fetchConnections(
	controller: string,
	secret: string,
	timeoutMs = 1500,
): Promise<ClashConnRow[]> {
	const headers: Record<string, string> =
		secret.length > 0 ? { Authorization: `Bearer ${secret}` } : {};
	const res = await fetch(`http://${controller}/connections`, {
		headers,
		signal: AbortSignal.timeout(timeoutMs),
		cache: "no-store",
	});
	if (!res.ok) throw new Error(`clash api answered ${res.status}`);
	const body: unknown = await res.json();
	const connections = objOf(body)?.connections;
	return arrOf(connections) ?? [];
}

/** Watched-process byte total — the egress the acceptance names. */
const bytesOf = (rows: ClashConnRow[]): number => {
	let total = 0;
	for (const row of rows) {
		const up = numOf(row.upload);
		const down = numOf(row.download);
		total += (up ?? 0) + (down ?? 0);
	}
	return total;
};

/** The acceptance verdict over a set of live rows: any watched-process
 *  connection on direct = FAIL (the enforcement hole), watched on
 *  hub-relay = PASS with counts, nothing watched in the window =
 *  INCONCLUSIVE (enforcement live, nothing to attribute). */
export function verifyRows(
	root: Record<string, unknown>,
	rows: ClashConnRow[],
): {
	verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
	reason: string;
	hub: number;
	leaks: number;
	blocked: number;
	rest: number;
	watchedBytes: number;
} {
	const law = checkConfigLaw(root);
	if (law.length > 0)
		return {
			verdict: "FAIL",
			reason: `conf law: ${law[0]}`,
			hub: 0,
			leaks: 0,
			blocked: 0,
			rest: 0,
			watchedBytes: 0,
		};
	const v = rowsVerdict(root, rows);
	return { verdict: v.verdict, reason: v.reason, ...countsOf(root, rows) };
}

/** The row-level verdict (config law already held). */
const rowsVerdict = (
	root: Record<string, unknown>,
	rows: ClashConnRow[],
): { verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; reason: string } => {
	const c = classifyConnections(rows, watchedRulesOf(root));
	if (c.leaks.length > 0)
		return {
			verdict: "FAIL",
			reason: `${c.leaks.length} watched-process connection(s) egressing direct — enforcement hole`,
		};
	if (c.hub.length > 0)
		return {
			verdict: "PASS",
			reason: `${c.hub.length} watched connection(s) on hub-relay (${bytesOf(c.hub)} bytes), ${c.blocked.length} blocked, ${c.rest} unwatched direct`,
		};
	return {
		verdict: "INCONCLUSIVE",
		reason:
			"no watched-process traffic observed (enforcement live, nothing to attribute)",
	};
};

/** The per-class counts over live rows. */
const countsOf = (root: Record<string, unknown>, rows: ClashConnRow[]) => {
	const c = classifyConnections(rows, watchedRulesOf(root));
	return {
		hub: c.hub.length,
		leaks: c.leaks.length,
		blocked: c.blocked.length,
		rest: c.rest,
		watchedBytes: bytesOf(c.hub),
	};
};

/** Seed the machine conf from the repo template — once, never over a real
 *  config (--force is the explicit exception). The seed lands with
 *  placeholders INTACT: `check` refuses to bless it until filled. */
export function seedConf(target: string, force: boolean): string | null {
	if (!isAbsolute(target))
		throw new Error(`conf path must be absolute: ${target}`);
	if (!force && existsSync(target)) return null;
	const template = readFileSync(templatePath(), "utf8");
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, template, { mode: 0o600 });
	renameSync(tmp, target);
	return target;
}

/** Sample /connections over a window, dedup by connection id (first seen
 *  wins) — the attribution window for `verify --watch <seconds>`. */
export async function sampleWindow(
	controller: string,
	secret: string,
	watchS: number,
	pollMs = 2000,
	fetcher: typeof fetchConnections = fetchConnections,
): Promise<ClashConnRow[]> {
	const byId = new Map<string, ClashConnRow>();
	const deadline = Date.now() + watchS * 1000;
	for (;;) {
		try {
			for (const row of await fetcher(controller, secret)) {
				const id = strOf(row.id) ?? `${byId.size}`;
				if (!byId.has(id)) byId.set(id, row);
			}
		} catch {
			// a missed poll shrinks the window; the verdict rules on what was seen
		}
		if (Date.now() >= deadline) break;
		await Bun.sleep(pollMs);
	}
	return [...byId.values()];
}

/** Resolve the conf path for a verb: --conf > KLH_SINGBOX_CONF > default. */
const confPathOf = (p: { flag: (n: string) => string | null }): string => {
	const flag = p.flag("--conf");
	if (flag !== null) return flag;
	return defaultConfPath();
};

/** check — fleet-law validation; exit 0 clean, 1 with the problem list. */
const runCheck = (p: Parsed): number => {
	const path = confPathOf(p);
	const conf = readConf(path);
	const problems = checkConfigLaw(conf);
	if (problems.length > 0) {
		console.log(`✗ ${path} — ${problems.length} law problem(s):`);
		for (const problem of problems) console.log(`  - ${problem}`);
		return 1;
	}
	const api = clashApiOf(conf);
	console.log(
		`✓ ${path} passes fleet law (watched rules: ${watchedRulesOf(conf).length}, hub-relay forward proxy, clash api ${api?.controller})`,
	);
	return 0;
};

/** seed — template → machine conf, placeholders intact. */
const runSeed = (p: Parsed): number => {
	const path = confPathOf(p);
	const written = seedConf(path, p.flag("--force") !== null);
	if (written === null) {
		console.log(
			`= ${path} already exists — untouched (pass --force to overwrite with the template)`,
		);
		return 0;
	}
	console.log(`✓ seeded ${written} — fill every <PLACEHOLDER>, then run check`);
	return 0;
};

/** verify — the acceptance face: conf law + live process attribution.
 *  Exit: 0 PASS · 1 FAIL · 3 INCONCLUSIVE. */
const runVerify = async (p: Parsed): Promise<number> => {
	const path = confPathOf(p);
	const conf = readConf(path);
	const law = checkConfigLaw(conf);
	if (law.length > 0) {
		console.log(
			`✗ ${path} — ${law.length} law problem(s); run check for the list`,
		);
		return 1;
	}
	const api = clashApiOf(conf);
	if (api === null) {
		console.log("✗ no usable clash_api declaration — run check");
		return 1;
	}
	const watchS = numOf(Number(p.flag("--watch") ?? "0")) ?? 0;
	const rows = await sampleWindow(api.controller, api.secret, watchS);
	const out = verifyRows(conf, rows);
	for (const row of rows.slice(0, 12)) {
		const p2 = processPathOf(row);
		const short = p2.length > 60 ? `…${p2.slice(-59)}` : p2;
		console.log(
			`  ${short} → ${String(arrOf(row.chains)?.[0] ?? "?")} (${numOf(row.upload) ?? 0}↑/${numOf(row.download) ?? 0}↓)`,
		);
	}
	console.log(
		`SINGBOX-VERIFY: ${out.verdict} - ${out.reason} [hub=${out.hub} leaks=${out.leaks} blocked=${out.blocked} rest=${out.rest}]`,
	);
	return out.verdict === "PASS" ? 0 : out.verdict === "FAIL" ? 1 : 3;
};

if (import.meta.main) {
	void runCli({
		prog: "singbox",
		about: "sing-box TUN egress enforcement kit (W1233):",
		verbs: [
			{
				name: "check",
				usage: "usage: singbox check [--conf <absolute path>]",
				flags: ["--conf"],
				run: runCheck,
			},
			{
				name: "seed",
				usage: "usage: singbox seed [--conf <absolute path>] [--force]",
				flags: ["--conf", "--force"],
				run: runSeed,
			},
			{
				name: "verify",
				usage:
					"usage: singbox verify [--conf <absolute path>] [--watch <seconds>]",
				flags: ["--conf", "--watch"],
				run: runVerify,
			},
		],
		epilog:
			"machine conf: ~/.config/klh/singbox.json (KLH_SINGBOX_CONF overrides)",
	});
}
