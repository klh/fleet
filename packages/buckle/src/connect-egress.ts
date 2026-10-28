// src/connect-egress.ts — W1260.2: the authenticated Buckle CONNECT egress.
// Loopback-only forward proxy that relays opaque AI TLS for Sing http
// outbounds (C111/C114 contract: 127.0.0.1:4103, Basic user=<app>,
// password=<BUCKLE_CONNECT_TOKEN>). Bytes are never decrypted: the CONNECT
// is answered, then the two TCP legs are spliced raw — TLS stays end-to-end
// between the app and the destination (no MITM, no plaintext visibility —
// tunnel metadata only: host/port/bytes/app, start/stop times, byte counts.
//
// Fail-closed: the endpoint does not EXIST unless gateway.connect.enabled is
// true AND BUCKLE_CONNECT_TOKEN is set AND connect.allow is non-empty; deny
// answers are 407 (auth) / 403 (destination) / 503 (capacity), then close.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { clampRetryAfter, parseRequestDeadline } from "./http-kit.ts";
import { createLogger } from "./log.ts";
import type { ConnectPolicyBlock, GatewayPolicy } from "./policy.ts";

const egressLog = createLogger("connect-egress");

/** W2173.7 HTTP citizenship: the egress identifies itself on every HTTP
 *  answer it writes over the wire (the 200 + every deny). The tunnel itself
 *  stays opaque TLS (C111) — no UA rides the relayed bytes, by design. */
export const CONNECT_EGRESS_UA = "buckle-connect-egress/1.0";

export const CONNECT_PORT_DEFAULT = 4103;
/** belt's live gateway address — the serve face refuses it (server.ts) and
 *  the CONNECT face refuses it here: one law, both planes. */
export const CONNECT_FORBIDDEN_PORT = 4100;
/** Authenticated app identities (C114): the Basic username IS the app.
 *  `buckle` = the generic identity → app "unknown"; anything else → 401. */
export const CONNECT_APPS = ["claude", "chatgpt", "vscode", "codex"] as const;
export type ConnectApp = (typeof CONNECT_APPS)[number] | "unknown";

/** W2173.7 zod-first: the schema is THE definition of the egress config —
 *  connectConfigOf guards its inputs, then the assembled config must parse
 *  (a guard/schema drift fails loud at boot). */
export const ConnectTunnelConfigSchema = z.object({
	enabled: z.literal(true),
	port: z.number().int().min(1).max(65535),
	ports: z.array(z.number().int().min(1).max(65535)).min(1),
	allow: z.array(z.string().min(1)).min(1),
	idleTimeoutMs: z.number().int().positive(),
	maxTunnels: z.number().int().min(1),
	/** SSRF/private/metadata denial — default on, tighten-only. */
	denyPrivate: z.boolean(),
	token: z.string().min(1),
});
export type ConnectTunnelConfig = z.infer<typeof ConnectTunnelConfigSchema>;

/** W1259 inflight-index contract (#67712): ingested VERBATIM via
 *  acceptConnectSnapshot — rows carry `app` per owner #67711 (Basic
 *  username only, never inferred from destination/domain). by_dest stays
 *  destination-keyed and claims NO process certainty. TLS plaintext is NOT
 *  visible to this plane; rows are tunnel metadata, nothing more. */
export interface ConnectTunnelRow {
	id: string;
	host: string;
	port: number;
	app: ConnectApp;
	openedAt: number;
	bytesUp: number;
	bytesDown: number;
	state: "held" | "closing";
}

export interface ConnectSnapshot {
	held: ConnectTunnelRow[];
	count: number;
}

/** Minimal structural socket face — Bun's TCPSocket satisfies it; the
 *  dialer and handlers ride this shape so bun-types drift cannot bite. */
export interface EgressSocket {
	write(data: string | Uint8Array): number;
	end(data?: string | Uint8Array): number;
	close(): void;
	data: unknown;
}

export type ResolverFn = (
	host: string,
	opts: { all: true },
) => Promise<{ address: string; family: number }[]>;

// ─── dial citizenship (W2173.7) ─────────────────────────────────────────────

/** Bounded dial backoff (seconds→ms): the delay after attempt N failed,
 *  CLAMPED through http-kit's clampRetryAfter — a dial ladder never sleeps
 *  unbounded, and a caller deadline shorter than the cap wins anyway. */
export const dialBackoffMs = (
	attempt: number,
	backoffBaseS: number,
	backoffMaxS: number,
): number =>
	attempt >= 1
		? clampRetryAfter(attempt * backoffBaseS, backoffMaxS) * 1000
		: 0;

/** The dial budget for one attempt: min(configured timeout, the remaining
 *  caller x-request-deadline propagated on the CONNECT head). A caller
 *  deadline tighter than the configured timeout wins (deadline
 *  propagation end-to-end, http-kit's DEADLINE_HEADER grammar). */
export const dialBudgetMs = (
	connectTimeoutMs: number,
	deadlineHeader: string | undefined,
	now: () => number = Date.now,
): number => {
	if (deadlineHeader === undefined) return connectTimeoutMs;
	const d = parseRequestDeadline(
		new Headers({ "x-request-deadline": deadlineHeader }),
		now,
	);
	return d === null
		? connectTimeoutMs
		: Math.min(connectTimeoutMs, Math.max(0, d.remainingMs));
};

// ─── config ─────────────────────────────────────────────────────────────────

/** Resolve the egress config from policy + env. null = INERT (the endpoint
 *  never starts: missing enabled/token/allow, empty ports). Port 4100 and
 *  malformed ports THROW — fail loud at boot, never silently off. */
export function connectConfigOf(
	policy: GatewayPolicy,
	env: Record<string, string | undefined> = process.env,
): ConnectTunnelConfig | null {
	const block: ConnectPolicyBlock = policy.connect ?? {};
	const token = env.BUCKLE_CONNECT_TOKEN ?? "";
	const allow = (block.allow ?? []).map((a) => a.trim()).filter(Boolean);
	if (block.enabled !== true || token.length === 0 || allow.length === 0)
		return null;
	const raw = env.BUCKLE_CONNECT_PORT ?? block.port ?? CONNECT_PORT_DEFAULT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`connect egress: bad port ${raw}`);
	if (port === 4100)
		throw new Error("connect egress: port 4100 is belt's address — refused");
	const ports = (block.ports ?? [443])
		.map(Number)
		.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
	if (ports.length === 0) return null;
	const idle = Number(block.idle_timeout_s ?? 300);
	const max = Number(block.max_tunnels ?? 64);
	// the schema is the contract — a guard above drifting from the schema
	// fails loud here instead of shipping a malformed config
	return ConnectTunnelConfigSchema.parse({
		enabled: true,
		port,
		ports,
		allow,
		token,
		idleTimeoutMs: Number.isFinite(idle) && idle > 0 ? idle * 1000 : 300_000,
		maxTunnels: Number.isInteger(max) && max >= 1 ? max : 64,
		denyPrivate: block.deny_private !== false,
	});
}

// ─── SSRF guard ─────────────────── adapters/egress.ts is the outbound sibling

const V4_RANGES: [number, number][] = [
	[0x00000000, 0x000000ff], // 0.0.0.0/8 "this network"
	[0x0a000000, 0x0affffff], // 10/8
	[0x64400000, 0x647fffff], // 100.64/10 CGNAT
	[0x7f000000, 0x7fffffff], // 127/8 loopback
	[0xa9fe0000, 0xa9feffff], // 169.254/16 link-local (cloud metadata)
	[0xac100000, 0xac1fffff], // 172.16/12
	[0xc0000000, 0xc00000ff], // 192.0.0/24
	[0xc0000200, 0xc00002ff], // 192.0.2/24 TEST-NET-1
	[0xc0a80000, 0xc0a8ffff], // 192.168/16
	[0xc6120000, 0xc613ffff], // 198.18/15 benchmark (sing TUN range)
	[0xc6336400, 0xc63364ff], // 198.51.100/24 TEST-NET-2
	[0xcb007100, 0xcb0071ff], // 203.0.113/24 TEST-NET-3
	[0xe0000000, 0xefffffff], // 224/4 multicast
	[0xf0000000, 0xffffffff], // 240/4 reserved + broadcast
];

/** v6 [prefixHex, prefixLen] → [lo, hi] as 128-bit BigInts. */
const v6Range = (hex: string, len: number): [bigint, bigint] => {
	const lo = BigInt(`0x${hex}`);
	return [lo, lo | ((1n << BigInt(128 - len)) - 1n)];
};

const V6_RANGES: [bigint, bigint][] = [
	v6Range("0".repeat(32), 128), // ::/128 unspecified
	v6Range(`0${"0".repeat(31)}1`, 128), // ::1/128 loopback
	v6Range(`ffff${"0".repeat(28)}`, 96), // ::ffff:0:0/96 v4-mapped
	v6Range(`fc${"0".repeat(30)}`, 7), // fc00::/7 ULA
	v6Range(`fe80${"0".repeat(28)}`, 10), // fe80::/10 link-local
	v6Range(`ff${"0".repeat(30)}`, 8), // ff00::/8 multicast
	v6Range(`20010db8${"0".repeat(24)}`, 32), // 2001:db8::/32 doc range
];

/** Parse an IPv6 literal to its 128-bit value; null when not valid v6. */
export function expandIPv6(raw: string): bigint | null {
	let s = raw.trim().toLowerCase();
	if (s.includes("%")) s = s.slice(0, s.indexOf("%"));
	const dc = s.split("::");
	if (dc.length > 2) return null;
	const parseGroups = (part: string): number[] | null => {
		const groups: number[] = [];
		for (const g of part.split(":")) {
			if (g === "") continue;
			if (g.includes(".")) {
				const v4 = parseIPv4(g);
				if (v4 === null) return null;
				groups.push(v4 >>> 16, v4 & 0xffff);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			groups.push(Number.parseInt(g, 16));
		}
		return groups;
	};
	const left = parseGroups(dc[0] ?? "");
	if (dc.length === 1) {
		if (left === null || left.length !== 8) return null;
		return groupsToBig(left);
	}
	const right = parseGroups(dc[1] ?? "");
	if (left === null || right === null) return null;
	const fill = 8 - left.length - right.length;
	if (fill < 0) return null;
	return groupsToBig([...left, ...Array<number>(fill).fill(0), ...right]);
}

const groupsToBig = (groups: number[]): bigint =>
	groups.reduce((acc, g) => (acc << 16n) | BigInt(g & 0xffff), 0n);

const parseIPv4 = (raw: string): number | null => {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
	if (!m) return null;
	let v = 0;
	for (const g of m.slice(1)) {
		const o = Number(g);
		if (!Number.isInteger(o) || o > 255) return null;
		v = (v << 8) | o;
	}
	return v >>> 0;
};

/** True when the address must never be a CONNECT destination. Unparseable
 *  input denies (fail closed). Covers v4, v4-mapped and plain v6. */
export function isDeniedIp(ip: string): boolean {
	const s = ip.trim().toLowerCase();
	if (isIPv4(s)) {
		const v = parseIPv4(s);
		if (v === null) return true;
		return V4_RANGES.some(([lo, hi]) => v >= lo && v <= hi);
	}
	const big = expandIPv6(s);
	if (big === null) return true;
	if (big >> 32n === 0xffffn) {
		const v = Number(big & 0xffffffffn) >>> 0;
		return V4_RANGES.some(([lo, hi]) => v >= lo && v <= hi);
	}
	return V6_RANGES.some(([lo, hi]) => big >= lo && big <= hi);
}

/** Allowlist match: "host.tld" matches the host and its subdomains (suffix
 *  with boundary — "evil-chatgpt.com" must NOT match "chatgpt.com"). */
export const hostMatchesAllow = (
	host: string,
	allow: readonly string[],
): boolean => {
	const h = host.trim().toLowerCase().replace(/\.+$/, "");
	return allow.some((a) => {
		const e = a.trim().toLowerCase().replace(/^\*\./, "").replace(/\.+$/, "");
		return h === e || h.endsWith(`.${e}`);
	});
};

export type DenyReason = "port" | "not-allowlisted" | "private" | "resolve";

/** The destination law: allowed port → allowlisted host → no private/
 *  metadata/benchmark address among the RESOLVED addresses (a mixed answer
 *  denies — the DNS-rebinding guard). Literal IPs skip resolution. */
export const destinationVerdict = async (
	authority: { host: string; port: number },
	cfg: Pick<ConnectTunnelConfig, "ports" | "allow" | "denyPrivate">,
	resolveFn: ResolverFn = lookup,
): Promise<{ ok: true; ip: string } | { ok: false; why: DenyReason }> => {
	if (!cfg.ports.includes(authority.port)) return { ok: false, why: "port" };
	if (!hostMatchesAllow(authority.host, cfg.allow))
		return { ok: false, why: "not-allowlisted" };
	const host = authority.host.replace(/^\[|\]$/g, "");
	if (isIPv4(host) || host.includes(":")) {
		if (cfg.denyPrivate && isDeniedIp(host))
			return { ok: false, why: "private" };
		return { ok: true, ip: host };
	}
	let addrs: { address: string; family: number }[];
	try {
		addrs = await resolveFn(host, { all: true });
	} catch {
		return { ok: false, why: "resolve" };
	}
	if (addrs.length === 0) return { ok: false, why: "resolve" };
	if (cfg.denyPrivate && addrs.some((a) => isDeniedIp(a.address)))
		return { ok: false, why: "private" };
	return { ok: true, ip: addrs[0]?.address ?? "" };
};

// ─── auth ───────────────────────────────────────────────────────────────────

/** Parse Proxy-Authorization Basic and return the authenticated app —
 *  the username IS the app (C114): claude|chatgpt|vscode|codex, or
 *  `buckle` = "unknown". Null on ANY mismatch (null → 407). The password
 *  comparison runs on fixed-length SHA-256 digests so it is constant-time
 *  for every input shape. */
export function authAppOf(
	header: string | undefined | null,
	token: string,
): ConnectApp | null {
	if (!header || token.length === 0) return null;
	const parsed = ProxyAuthorizationSchema.safeParse(header.trim());
	if (!parsed.success) return null;
	let decoded = "";
	try {
		decoded = Buffer.from(parsed.data, "base64").toString("utf8");
	} catch {
		return null;
	}
	const sep = decoded.indexOf(":");
	if (sep < 0) return null;
	const user = decoded.slice(0, sep);
	const pass = decoded.slice(sep + 1);
	if (user !== "buckle" && !CONNECT_APPS.includes(user as never)) return null;
	const a = createHash("sha256").update(pass).digest();
	const b = createHash("sha256").update(token).digest();
	return timingSafeEqual(a, b)
		? user === "buckle"
			? "unknown"
			: (user as ConnectApp)
		: null;
}

// ─── registry ───────────────────────────────────────────────────────────────

/** The held-tunnel ledger: the EXACT active held connection metadata the
 *  W1259 index ingests (verbatim shape), plus deny counters for the
 *  servicemon face. Rows are copies — mutation cannot leak into snapshots. */
export class ConnectRegistry {
	private held = new Map<string, ConnectTunnelRow>();
	private denied = new Map<string, number>();
	readonly totals = { opened: 0, closed: 0, denied: 0 };

	open(row: ConnectTunnelRow): void {
		this.held.set(row.id, row);
		this.totals.opened++;
	}

	close(id: string): void {
		const row = this.held.get(id);
		if (!row) return;
		row.state = "closing";
		this.held.delete(id);
		this.totals.closed++;
	}

	deny(reason: string): void {
		this.denied.set(reason, (this.denied.get(reason) ?? 0) + 1);
		this.totals.denied++;
	}

	deniedOf(reason: string): number {
		return this.denied.get(reason) ?? 0;
	}

	get size(): number {
		return this.held.size;
	}

	/** The W1259 contract: {held: [{id, host, port, openedAt, bytesUp,
	 *  bytesDown, state, app}], count} — verbatim, never narrower. */
	snapshot(): ConnectSnapshot {
		const rows = [...this.held.values()].sort(
			(a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1),
		);
		return { held: rows.map((r) => ({ ...r })), count: rows.length };
	}
}

// ─── the CONNECT listener ───────────────────────────────────────────────────

const MAX_HEADER_BYTES = 8192;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

interface Leg {
	phase: "head" | "tunnel";
	buf: Buffer;
	id?: string;
	peer?: EgressSocket;
	sock?: EgressSocket;
	row?: ConnectTunnelRow;
	pendingUp: number;
	pendingDown: number;
	idle?: ReturnType<typeof setTimeout>;
	closed: boolean;
}

/** Deny counters, held-tunnel registry and the loopback Bun.listen. The
 *  listener binds 127.0.0.1 STRUCTURALLY — there is no bind knob at all
 *  (C111/C114: loopback-only is the contract, not a default). */
export class ConnectEgress {
	readonly registry = new ConnectRegistry();
	private listener: { stop(close: boolean): void; port: number } | null = null;
	private live = new Set<Leg>();

	constructor(
		private readonly cfg: ConnectTunnelConfig,
		private readonly opts: ConnectEgressOpts = {},
	) {
		if (cfg.port === CONNECT_FORBIDDEN_PORT)
			throw new Error(
				`connect egress: port ${CONNECT_FORBIDDEN_PORT} is belt's address — refused`,
			);
	}

	/** Bind 127.0.0.1. Returns this; the assigned port rides `.port`. */
	start(): this {
		this.listener = Bun.listen({
			hostname: "127.0.0.1",
			port: this.cfg.port,
			socket: {
				open: (s) => this.onOpen(s),
				data: (s, d) => this.onData(s, d),
				close: (s) => this.teardown(s.data as Leg | undefined),
				error: (s) => this.teardown(s.data as Leg | undefined),
			},
		});
		return this;
	}

	get port(): number {
		return this.listener?.port ?? 0;
	}

	/** One live leg per client socket; leg rides socket.data (never seeded
	 *  by Bun — assigned here, per the W624-class socket.data lesson). */
	private onOpen(s: EgressSocket): void {
		const leg: Leg = {
			phase: "head",
			buf: Buffer.alloc(0),
			pendingUp: 0,
			pendingDown: 0,
			closed: false,
		};
		s.data = leg;
		leg.sock = s;
		this.live.add(leg);
		this.touch(leg);
	}

	/** Rearm the idle timer (unref'd — a pending deadline never holds the
	 *  event loop; bun pending-setTimeout lesson). */
	private touch(leg: Leg): void {
		if (leg.idle) clearTimeout(leg.idle);
		leg.idle = setTimeout(() => {
			this.registry.deny("idle");
			this.teardown(leg, true);
		}, this.cfg.idleTimeoutMs);
		leg.idle.unref?.();
	}

	private onData(s: EgressSocket, chunk: Buffer): void {
		const leg = s.data as Leg | undefined;
		if (!leg || leg.closed) return;
		this.touch(leg);
		if (leg.phase === "head") {
			leg.buf = Buffer.concat([leg.buf, chunk]);
			if (leg.buf.length > MAX_HEADER_BYTES) {
				this.registry.deny("headers");
				this.fail(s, leg, 431, "Request Header Fields Too Large");
				return;
			}
			const end = leg.buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = leg.buf.subarray(0, end).toString("latin1");
			const rest = Buffer.from(leg.buf.subarray(end + 4));
			leg.buf = Buffer.alloc(0);
			void this.handleRequest(s, leg, head, rest);
			return;
		}
		this.spliceUp(leg, chunk);
	}

	/** client → upstream splice with a bounded unflushed window (write()
	 *  returns the flushed count; a peer that stops draining aborts the
	 *  tunnel instead of buffering without bound). */
	private spliceUp(leg: Leg, chunk: Buffer): void {
		const row = leg.row;
		const peer = leg.peer;
		if (!row || !peer) return;
		this.touch(leg);
		row.bytesUp += chunk.length;
		leg.pendingUp += chunk.length;
		leg.pendingUp -= peer.write(chunk);
		if (leg.pendingUp > MAX_PENDING_BYTES) {
			this.registry.deny("backpressure");
			this.teardown(leg, true);
		}
	}

	/** Answer the deny (407/403/431/503...), count the reason, close. */
	private fail(s: EgressSocket, leg: Leg, code: number, why: string): void {
		this.registry.deny(why);
		leg.closed = true; // no further onData races — the close event reaps
		if (leg.idle) clearTimeout(leg.idle);
		this.live.delete(leg);
		try {
			s.write(
				`HTTP/1.1 ${code} ${why}\r\nuser-agent: ${CONNECT_EGRESS_UA}\r\n\r\n`,
			);
			s.end();
		} catch {
			s.close();
		}
	}

	/** Close both legs; the registry row (if any) leaves the held index. */
	private teardown(leg: Leg | undefined, closeClient = false): void {
		if (!leg || leg.closed) return;
		leg.closed = true;
		if (leg.idle) clearTimeout(leg.idle);
		this.live.delete(leg);
		if (leg.row) this.registry.close(leg.row.id);
		if (leg.peer) {
			try {
				leg.peer.end();
			} catch {
				leg.peer.close();
			}
		}
		leg.peer = undefined;
		if (closeClient && leg.sock) {
			try {
				leg.sock.end();
			} catch {
				leg.sock.close();
			}
		}
		leg.sock = undefined;
	}

	private async handleRequest(
		s: EgressSocket,
		leg: Leg,
		head: string,
		rest: Buffer,
	): Promise<void> {
		const lines = head.split("\r\n");
		// W2173.7 zod-first: the request-line shape is schema-validated, not
		// inline-regexed — a malformed line 405s before any auth work.
		const line = ConnectRequestLineSchema.safeParse(lines[0] ?? "");
		if (!line.success) {
			this.fail(s, leg, 405, "Method Not Allowed");
			return;
		}
		const headers = new Map<string, string>();
		for (const l of lines.slice(1)) {
			const i = l.indexOf(":");
			if (i < 0) continue;
			headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
		}
		const auth = headers.get("proxy-authorization");
		const app = authAppOf(auth, this.cfg.token);
		if (!app) {
			this.fail(s, leg, 407, "Proxy Authentication Required");
			return;
		}
		if (this.registry.size >= this.cfg.maxTunnels) {
			this.fail(s, leg, 503, "Service Unavailable");
			return;
		}
		const authority = parseAuthority(line.data.authority);
		if (!authority) {
			this.fail(s, leg, 400, "Bad Request");
			return;
		}
		const verdict = await destinationVerdict(
			authority,
			this.cfg,
			this.opts.resolve,
		);
		if (!verdict.ok) {
			this.fail(s, leg, 403, "Forbidden");
			return;
		}
		// W2173.7: the dial budget = configured timeout tightened by the
		// caller's x-request-deadline (deadline propagation end-to-end).
		const budgetMs = dialBudgetMs(
			this.opts.connectTimeoutMs ?? 5000,
			headers.get("x-request-deadline"),
		);
		const peer = await this.dial(verdict.ip, authority.port, budgetMs);
		if (!peer.ok) {
			this.fail(s, leg, 502, "Bad Gateway");
			return;
		}
		if (leg.closed) {
			peer.value.end();
			return;
		}
		const row: ConnectTunnelRow = {
			id: randomUUID(),
			host: authority.host,
			port: authority.port,
			app,
			openedAt: Date.now(),
			bytesUp: 0,
			bytesDown: 0,
			state: "held",
		};
		leg.phase = "tunnel";
		leg.peer = peer.value;
		leg.sock = s;
		leg.row = row;
		peer.value.data = leg;
		this.registry.open(row);
		this.opts.sm
			?.counter(
				"buckle_connect_tunnels_opened_total",
				"Held CONNECT tunnels opened.",
			)
			.inc({ app }, 1);
		s.write(
			`HTTP/1.1 200 Connection established\r\nuser-agent: ${CONNECT_EGRESS_UA}\r\n\r\n`,
		);
		if (rest.length > 0) this.spliceUp(leg, rest);
	}

	/** W2173.7 bounded dial ladder: up to opts.dialAttempts (default 2)
	 *  Bun.connect attempts on a clampRetryAfter-bounded backoff — a
	 *  transient upstream refusal gets a bounded second chance; the caller
	 *  deadline (budgetMs) caps the whole ladder. */
	private async dial(
		ip: string,
		port: number,
		budgetMs: number,
	): Promise<{ ok: true; value: EgressSocket } | { ok: false }> {
		const attempts = Math.max(1, this.opts.dialAttempts ?? 2);
		const baseS = this.opts.backoffBaseS ?? 1;
		const maxS = this.opts.backoffMaxS ?? 3;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const peer = await this.dialOnce(ip, port, Math.max(1, budgetMs));
			if (peer.ok) return peer;
			if (attempt >= attempts) return { ok: false };
			const delay = dialBackoffMs(attempt, baseS, maxS);
			if (delay > 0) await Bun.sleep(delay);
		}
		return { ok: false };
	}

	/** One Bun.connect attempt raced against the signal-owned deadline; a
	 *  hung SYN never holds the tunnel. Loser sockets end(). */
	private dialOnce(
		ip: string,
		port: number,
		budgetMs: number,
	): Promise<{ ok: true; value: EgressSocket } | { ok: false }> {
		const timeoutMs = Math.max(1, budgetMs);
		return new Promise((res) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (
				r: { ok: true; value: EgressSocket } | { ok: false },
			): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				res(r);
			};
			// W2173.7: the deadline rides an AbortSignal — abort() settles the
			// race and the unref'd timer only arms the signal (a pending
			// deadline never holds the event loop).
			const ctrl = new AbortController();
			ctrl.signal.addEventListener("abort", () => done({ ok: false }), {
				once: true,
			});
			timer = setTimeout(() => ctrl.abort(), timeoutMs);
			timer.unref?.();
			const upHandler = (peer: object): void =>
				this.teardown((peer as EgressSocket).data as Leg | undefined);
			Bun.connect({
				hostname: ip,
				port,
				socket: {
					data: (peer, d) => this.onUpData(peer as EgressSocket, d),
					close: upHandler,
					error: upHandler,
				},
			}).then(
				(peer) => {
					if (settled) {
						peer.end();
						return;
					}
					done({ ok: true, value: peer as EgressSocket });
				},
				() => done({ ok: false }),
			);
		});
	}

	/** upstream → client splice (mirrors spliceUp's bounded window). */
	private onUpData(peer: EgressSocket, chunk: Buffer): void {
		const leg = peer.data as Leg | undefined;
		if (!leg || leg.closed) return;
		const row = leg.row;
		const sock = leg.sock;
		if (!row || !sock) return;
		this.touch(leg);
		row.bytesDown += chunk.length;
		leg.pendingDown += chunk.length;
		leg.pendingDown -= sock.write(chunk);
		if (leg.pendingDown > MAX_PENDING_BYTES) {
			this.registry.deny("backpressure");
			this.teardown(leg, true);
		}
	}

	/** Stop the listener and tear down every live leg (tests + drain). */
	stop(): void {
		this.listener?.stop(true);
		this.listener = null;
		for (const leg of [...this.live]) this.teardown(leg, true);
	}
}

/** Optional wiring: injectable resolver (tests) + bounded dial + metrics.
 *  W2173.7 adds the dial-ladder knobs: dialAttempts (total attempts,
 *  default 2) and the clampRetryAfter-bounded backoff params. */
export interface ConnectEgressOpts {
	resolve?: ResolverFn;
	connectTimeoutMs?: number;
	dialAttempts?: number;
	backoffBaseS?: number;
	backoffMaxS?: number;
	sm?: {
		counter(
			name: string,
			help: string,
		): { inc(labels?: Record<string, string | number>, n?: number): void };
	};
}

/** CONNECT request line — "CONNECT <authority> HTTP/1.x" (case-insensitive
 *  method, 1.0 or 1.1). The schema is THE definition of the line shape. */
export const ConnectRequestLineSchema = z
	.string()
	.regex(
		/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i,
		"expected: CONNECT <host>:<port> HTTP/1.0|1.1",
	)
	.transform((s) => ({
		authority: s.trim().split(/\s+/)[1] ?? "",
	}));

/** Proxy-Authorization Basic credential (RFC 7617 shape) — parses to the
 *  base64 payload (the prefix is stripped by the transform). */
export const ProxyAuthorizationSchema = z
	.string()
	.regex(/^Basic\s+([A-Za-z0-9+/=]+)$/i, "expected: Basic <base64>")
	.transform((s) => s.replace(/^Basic\s+/i, ""));

/** CONNECT authority → {host, port}. Zod-first (W2173.7): the schema is
 *  THE definition — v6 must be bracketed ([::1]:443); a bare-colon host
 *  without brackets refuses (ambiguous). */
const AUTHORITY_RE = /^(?:\[(.+)\]|([^:\]]+)):([0-9]{1,5})$/;
export const AuthoritySchema = z
	.string()
	.regex(AUTHORITY_RE, "expected: host:port or [v6]:port")
	.transform((s): { host: string; port: number } | null => {
		const m = AUTHORITY_RE.exec(s.trim());
		if (!m) return null;
		const port = Number(m[3]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
		return { host: m[1] !== undefined ? `[${m[1]}]` : (m[2] ?? ""), port };
	});

/** CONNECT authority → {host, port} | null (null = refused authority). */
export const parseAuthority = (
	raw: string,
): { host: string; port: number } | null => {
	const r = AuthoritySchema.safeParse(raw.trim());
	return r.success ? (r.data ?? null) : null;
};

/** Boot seam: resolve config; null = inert (no listener). Throws on port
 *  collisions — belt's 4100 and the buckle serve face. */
export function startConnectEgress(
	policy: GatewayPolicy,
	servePort: number,
	opts: ConnectEgressOpts = {},
): ConnectEgress | undefined {
	const cfg = connectConfigOf(policy);
	if (!cfg) return undefined;
	if (cfg.port === servePort)
		throw new Error(
			`connect egress: port ${cfg.port} collides with the buckle serve face`,
		);
	const egress = new ConnectEgress(cfg, opts).start();
	egressLog.info(
		`connect egress on 127.0.0.1:${egress.port} — apps ${CONNECT_APPS.join("/")}+buckle, destinations [${cfg.allow.join(", ")}]:${cfg.ports.join("/")}, TLS stays opaque`,
	);
	return egress;
}
