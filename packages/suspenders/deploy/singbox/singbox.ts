// deploy/singbox/singbox.ts — W1233 + W1260.1: per-process TUN egress
// enforcement. sing-box = the network-layer enforcement/audit hop (bytes flow
// through the machine's TUN); every DETECTED AI connection routes by default
// through LOCAL BUCKLE's authenticated HTTP CONNECT egress (W1260.2): one
// http outbound per app, username = app identity, password =
// BUCKLE_CONNECT_TOKEN (machine env). The outbound is an HTTP CONNECT CLIENT
// relaying the app's TLS opaque end-to-end — never a wire translation, never
// a MITM; buckle sees app identity + byte counts, never plaintext.
// Config-over-code: the real sing-box config lives in machine conf
// (~/.config/klh/singbox.json); this kit owns the fleet LAW for that config,
// a one-time seed from the repo template, and the acceptance verifier that
// reads sing-box's clash API for live per-process attribution.
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
import {
	AI_DESTINATION_SUFFIXES,
	CONNECT_PREFIX,
	CONNECT_SERVER,
	CONNECT_UNKNOWN_USER,
	CONNECT_USERS,
	compileRegexOf,
	connectTagOf,
	goRegexOf,
	guiTransports,
} from "./watched.ts";

const DIRECT_TAG = "direct";
const BLOCK_TAG = "block";

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

/** Outbound law: every buckle-connect outbound is an authenticated local
 *  CONNECT client (W1260.2 contract); every watched app covered once. */
export function lawOutbounds(root: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const rows = outboundsOf(root);
	const connects = rows.filter(
		(o) => strOf(o.tag)?.startsWith(CONNECT_PREFIX) === true,
	);
	for (const o of connects) problems.push(...connectRowProblems(o));
	for (const u of CONNECT_USERS)
		if (!connects.some((o) => strOf(o.tag) === connectTagOf(u)))
			problems.push(
				`outbounds: no ${connectTagOf(u)} outbound (default-on coverage)`,
			);
	const tags = new Set(rows.map((o) => strOf(o.tag) ?? ""));
	if (!tags.has(DIRECT_TAG))
		problems.push(`outbounds: a ${DIRECT_TAG} outbound is required`);
	if (!tags.has(BLOCK_TAG))
		problems.push(`outbounds: a ${BLOCK_TAG} outbound is required`);
	return problems;
}

/** The outbound rows as clean objects. */
const outboundsOf = (
	root: Record<string, unknown>,
): Record<string, unknown>[] =>
	(arrOf(root.outbounds) ?? [])
		.map(objOf)
		.filter((o): o is Record<string, unknown> => o !== null);

/** The per-outbound CONNECT law: http type, loopback server, valid port,
 *  username = watched app = tag suffix, filled password. */
const connectRowProblems = (o: Record<string, unknown>): string[] => {
	const tag = strOf(o.tag) ?? "";
	const app = tag.slice(CONNECT_PREFIX.length);
	const problems: string[] = [];
	const port = numOf(o.server_port);
	if (strOf(o.type) !== "http")
		problems.push(
			`${tag}.type must be http — HTTP CONNECT client, TLS stays opaque`,
		);
	if (strOf(o.server) !== CONNECT_SERVER)
		problems.push(
			`${tag}.server must be ${CONNECT_SERVER} (loopback-only egress)`,
		);
	if (port === null || port < PORT_MIN || port > PORT_MAX)
		problems.push(
			`${tag}.server_port must be an integer ${PORT_MIN}-${PORT_MAX}`,
		);
	const known = new Set<string>(CONNECT_USERS);
	const user = strOf(o.username);
	if (user === null || !known.has(user))
		problems.push(
			`${tag}.username must be a CONNECT identity (${[...known].join(", ")})`,
		);
	if (user !== app)
		problems.push(`${tag}: username must equal the tag's app identity`);
	if (strOf(o.password) === null)
		problems.push(
			`${tag}.password must be the BUCKLE_CONNECT_TOKEN (filled, never empty)`,
		);
	return problems;
};

/** The watched process_path_regex rules — every rule whose outbound targets
 *  a buckle-connect egress. process_path_regex accepts a scalar or a list
 *  (sing-box match fields); read both spellings. */
export function watchedRulesOf(
	root: Record<string, unknown>,
): { regex: string; compiled: RegExp }[] {
	const route = objOf(root.route);
	const rules = arrOf(route === null ? null : route.rules) ?? [];
	const out: { regex: string; compiled: RegExp }[] = [];
	for (const r of rules.map(objOf)) {
		if (r === null) continue;
		const rxs = regexesOf(r.process_path_regex);
		const tag = strOf(r.outbound);
		if (rxs === null || tag === null || !tag.startsWith(CONNECT_PREFIX))
			continue;
		for (const rx of rxs) {
			const compiled = goRegexOf(rx);
			if (compiled !== null) out.push({ regex: rx, compiled });
			// invalid regex — reported by lawRoute
		}
	}
	return out;
}

/** A match field value as a string list (scalar or list spellings). */
const regexesOf = (v: unknown): string[] | null => {
	const one = strOf(v);
	if (one !== null) return [one];
	const list = arrOf(v);
	if (list === null) return null;
	const out: string[] = [];
	for (const item of list) {
		const s = strOf(item);
		if (s === null) return null;
		out.push(s);
	}
	return out;
};

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
	for (const a of guiTransports()) {
		const compiled = compileRegexOf(a.user);
		const ruleOk =
			compiled !== null &&
			objs.some(
				(r) =>
					strOf(r.outbound) === connectTagOf(a.user) &&
					regexesOf(r.process_path_regex)?.includes(a.regex) === true,
			);
		if (!ruleOk) {
			problems.push(
				`route.rules: no ${connectTagOf(a.user)} rule (${a.regex})`,
			);
			continue;
		}
		for (const probe of a.probes) {
			if (compiled !== null && !compiled.test(probe))
				problems.push(
					`route.rules: ${connectTagOf(a.user)} regex misses probe ${probe}`,
				);
		}
	}
	// sniff law: SNI discovery must precede every domain-qualified rule —
	// the AI rules match the sniffed host, never an encrypted body.
	const sniffIdx = objs.findIndex((r) => r.action === "sniff");
	if (sniffIdx < 0)
		problems.push(
			"route.rules: a {action: sniff} rule is required (SNI populates the domain the AI rules match)",
		);
	// ordering law (owner #67813/#67819): private/LAN bypass BEFORE any
	// buckle-connect rule, else watched apps' local/auth/update traffic
	// hits the CONNECT gate and breaks GUIs.
	const firstConnect = objs.findIndex(
		(r) => strOf(r.outbound)?.startsWith(CONNECT_PREFIX) === true,
	);
	const firstBypass = objs.findIndex(
		(r) =>
			r.ip_is_private === true ||
			(arrOf(r.domain_suffix) !== null && r.outbound === DIRECT_TAG),
	);
	if (firstConnect >= 0 && firstBypass >= 0 && firstBypass > firstConnect)
		problems.push(
			"route.rules: private/LAN bypass must precede the buckle-connect rules (watched apps' local/auth traffic stays direct)",
		);
	if (sniffIdx >= 0 && firstConnect >= 0 && sniffIdx > firstConnect)
		problems.push(
			"route.rules: the sniff rule must precede the buckle-connect rules (the domain rules match what sniff saw)",
		);
	// domain-qualification law: every process rule must carry the FULL AI
	// destination set (sing-box ANDs the fields) — a watched app's non-AI
	// traffic never relays, only its AI destinations do.
	for (const r of objs) {
		if (!("process_path_regex" in r)) continue;
		const suffixes = (arrOf(r.domain_suffix) ?? []).map((s) => strOf(s) ?? "");
		const covers = AI_DESTINATION_SUFFIXES.every((s) => suffixes.includes(s));
		if (!covers)
			problems.push(
				"route.rules: a process rule must qualify by the full AI destination set (non-AI traffic of watched apps stays direct)",
			);
	}
	// AI-fallback law: unknown processes' AI destinations ride the CONNECT
	// gate as the `buckle` bucket; everything else of theirs stays direct.
	const fallbackOk = objs.some(
		(r) =>
			!("process_path_regex" in r) &&
			strOf(r.outbound) === connectTagOf(CONNECT_UNKNOWN_USER) &&
			AI_DESTINATION_SUFFIXES.every((s) =>
				(arrOf(r.domain_suffix) ?? []).includes(s),
			),
	);
	if (!fallbackOk)
		problems.push(
			`route.rules: an AI-destination fallback rule must route unknown processes to ${connectTagOf(CONNECT_UNKNOWN_USER)}`,
		);
	for (const r of objs) {
		if (!("process_path_regex" in r)) continue;
		const tag = strOf(r.outbound);
		if (tag === null || !tag.startsWith(CONNECT_PREFIX))
			problems.push(
				`route.rules: a process_path_regex rule must target a buckle-connect outbound (found ${tag ?? "?"})`,
			);
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

/** The sniffed/virtual host a row went to ("" when unknown — IP-only rows
 *  are never domain-claimed). */
export function hostOfRow(row: ClashConnRow): string {
	const m = row.metadata;
	if (m === undefined) return "";
	return strOf(m.host) ?? "";
}

/** Dot-boundary suffix match (honest domain_suffix reading). */
export const hostIsAi = (
	host: string,
	suffixes: readonly string[] = AI_DESTINATION_SUFFIXES,
): boolean => suffixes.some((s) => host === s || host.endsWith(`.${s}`));

/** Classify live rows against the watched set + AI destination set:
 *  buckle-connect egress = Buckle-visible; watched-app rows whose sniffed
 *  host is an AI destination and whose chain is NOT buckle-connect = LEAK
 *  (the enforcement hole); watched-app rows to non-AI destinations ride
 *  direct BY LAW (auth/update/local) — never claimed; everything else is
 *  unwatched. byTag breaks the connect rows down per egress identity. */
export function classifyConnections(
	rows: ClashConnRow[],
	watched: { compiled: RegExp }[],
	aiSuffixes: readonly string[] = AI_DESTINATION_SUFFIXES,
): {
	connect: ClashConnRow[];
	leaks: ClashConnRow[];
	blocked: ClashConnRow[];
	rest: number;
	byTag: Record<string, number>;
} {
	const connect: ClashConnRow[] = [];
	const leaks: ClashConnRow[] = [];
	const blocked: ClashConnRow[] = [];
	const byTag: Record<string, number> = {};
	let rest = 0;
	for (const row of rows) {
		const path = processPathOf(row);
		const isWatched = watched.some((w) => w.compiled.test(path));
		if (!isWatched) {
			rest++;
			continue;
		}
		const tag = strOf(arrOf(row.chains)?.[0]);
		if (tag?.startsWith(CONNECT_PREFIX)) {
			connect.push(row);
			byTag[tag] = (byTag[tag] ?? 0) + 1;
			continue;
		}
		// a watched app to a non-AI destination is direct BY LAW — never a
		// leak claim; only AI destinations behind the gate are enforced
		if (!hostIsAi(hostOfRow(row), aiSuffixes)) {
			rest++;
			continue;
		}
		if (tag === BLOCK_TAG) blocked.push(row);
		else leaks.push(row);
	}
	return { connect, leaks, blocked, rest, byTag };
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
 *  buckle-connect = PASS with counts, nothing watched in the window =
 *  INCONCLUSIVE (enforcement live, nothing to attribute). */
export function verifyRows(
	root: Record<string, unknown>,
	rows: ClashConnRow[],
): {
	verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
	reason: string;
	connect: number;
	leaks: number;
	blocked: number;
	rest: number;
	byTag: Record<string, number>;
	watchedBytes: number;
} {
	const law = checkConfigLaw(root);
	if (law.length > 0)
		return {
			verdict: "FAIL",
			reason: `conf law: ${law} problem(s)`,
			connect: 0,
			leaks: 0,
			blocked: 0,
			rest: 0,
			byTag: {},
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
			reason: `${c.leaks.length} watched-app AI connection(s) escaping the buckle-connect gate — enforcement hole`,
		};
	if (c.connect.length > 0)
		return {
			verdict: "PASS",
			reason: `${c.connect.length} AI connection(s) on buckle-connect (${bytesOf(c.connect)} bytes opaque TLS), ${c.blocked.length} blocked, ${c.rest} direct by law`,
		};
	return {
		verdict: "INCONCLUSIVE",
		reason:
			"no watched-app AI traffic observed (enforcement live, nothing to attribute)",
	};
};

/** The per-class counts over live rows. */
const countsOf = (root: Record<string, unknown>, rows: ClashConnRow[]) => {
	const c = classifyConnections(rows, watchedRulesOf(root));
	return {
		connect: c.connect.length,
		leaks: c.leaks.length,
		blocked: c.blocked.length,
		rest: c.rest,
		byTag: c.byTag,
		watchedBytes: bytesOf(c.connect),
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

/** check — fleet-law validation; exit 0 clean, 1 with the problem list.
 *  An absent/unparseable conf refuses clean, never a stack trace. */
const runCheck = (p: Parsed): number => {
	const path = confPathOf(p);
	let conf: Record<string, unknown>;
	try {
		conf = readConf(path);
	} catch (e) {
		console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
	const problems = checkConfigLaw(conf);
	if (problems.length > 0) {
		console.log(`✗ ${path} — ${problems.length} law problem(s):`);
		for (const problem of problems) console.log(`✗   - ${problem}`);
		return 1;
	}
	const api = clashApiOf(conf);
	console.log(
		`✓ ${path} passes fleet law (watched rules: ${watchedRulesOf(conf).length}, buckle-connect egress, clash api ${api?.controller})`,
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
 *  Exit: 0 PASS · 1 FAIL · 3 INCONCLUSIVE. An absent/unparseable conf or an
 *  unreachable clash API is INCONCLUSIVE/a clean refusal, never a trace. */
const runVerify = async (p: Parsed): Promise<number> => {
	const path = confPathOf(p);
	let conf: Record<string, unknown>;
	try {
		conf = readConf(path);
	} catch (e) {
		console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
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
	const tags = Object.entries(out.byTag)
		.map(([t, n]) => `${t}=${n}`)
		.join(" ");
	console.log(
		`SINGBOX-VERIFY: ${out.verdict} - ${out.reason} [connect=${out.connect} leaks=${out.leaks} blocked=${out.blocked} rest=${out.rest} byTag ${tags}]`,
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
