#!/usr/bin/env bun
// deploy/mdns/announce.ts — W854: the hub announces ITSELF on the LAN.
// hub-locate.ts's discovery leg (resolveHub step 4) browses _klh-hub._tcp;
// until now nothing ever advertised it, so `dns-sd -B _klh-hub._tcp local.`
// came back EMPTY and hubs were only reachable via per-machine loopback
// mappings. This announcer publishes the record set mDNS discovery needs —
// PTR (service browse), SRV (host:port), TXT (markers), A (the hub's LAN
// address) — answers queries for them, and says goodbye (TTL 0) on stop.
//
// Runs as the hub-compose `mdns-announce` service (network_mode: host, the
// oven/bun image — no new container image, no native deps: the mDNS wire
// format is hand-rolled on node:dgram multicast). Health law: the announcer
// serves its real state (socket mode, announce count, freshness) on
// HUB_MDNS_HEALTH_PORT and the OUTSIDE-PROCESS mdns-health sidecar polls
// that over the wire; compose health hits the sidecar, never this process.
//
// Knobs (env, config-over-code — stack.json `mdns:` renders them via
// hubctl render):
//   HUB_MDNS_LABEL        instance name (default HUB_NAME)
//   HUB_MDNS_PORT         advertised port (default HUB_BUCKLE_PORT or 4111)
//   HUB_MDNS_HOSTNAME     SRV target host label (default: normalized label)
//   HUB_MDNS_ADDR         advertised A-record IPv4 (default: auto-detect the
//                         primary outbound interface; when undetectable the
//                         A record is SKIPPED — never advertise 127.0.0.1)
//   HUB_MDNS_INTERVAL_MS  steady re-announce cadence (default 20000)
//   HUB_MDNS_HEALTH_PORT  self-report port (default 4114; 0 = random, for tests)
//
// Scope: one service type, one instance, record-level correctness. v1 has no
// probing/name-claim dance (a second announcer with the same label would
// conflict-rename on the resolver side; a warning is logged on conflict).

import dgram from "node:dgram";
import os from "node:os";

// --- wire constants -------------------------------------------------------
const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
export const SERVICE_TYPE = "_klh-hub._tcp";
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 0x0001;
const CACHE_FLUSH = 0x8000;
const QU_BIT = 0x8000;
// PTR lives long (the browse record); uniqueness records refresh often so a
// short TTL keeps stale hosts out of caches fast.
const TTL_PTR = 4500;
const TTL_UNIQUE = 120;

// --- config ---------------------------------------------------------------
export interface AnnouncerConfig {
	label: string;
	port: number;
	addr?: string;
	hostname: string;
	intervalMs: number;
	healthPort: number;
}

const firstNum = (v: string | undefined, dflt: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** The label's DNS-safe host form — mirrors hub-locate.ts's guessHost
 *  normalization so the SRV target IS the `<label>.local` the mdns-guess
 *  leg tries. */
export function hostForLabel(label: string): string {
	const h = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "");
	return h.length > 0 ? h : "klh-hub";
}

export function configFromEnv(
	env: Record<string, string | undefined> = process.env,
): AnnouncerConfig {
	const label = (env.HUB_MDNS_LABEL ?? env.HUB_NAME ?? "klh-hub").trim();
	return {
		label: label.length > 0 ? label : "klh-hub",
		port: firstNum(env.HUB_MDNS_PORT ?? env.HUB_BUCKLE_PORT, 4111),
		addr: env.HUB_MDNS_ADDR?.trim() || undefined,
		hostname: hostForLabel(env.HUB_MDNS_HOSTNAME ?? label),
		intervalMs: firstNum(env.HUB_MDNS_INTERVAL_MS, 20_000),
		healthPort:
			env.HUB_MDNS_HEALTH_PORT === "0"
				? 0
				: firstNum(env.HUB_MDNS_HEALTH_PORT, 4114),
	};
}

// --- DNS wire format ------------------------------------------------------
/** Encode a dotted name as DNS labels (no compression — mDNS tolerates it). */
export function encodeName(dotted: string): Buffer {
	const parts = dotted
		.replace(/\.$/, "")
		.split(".")
		.filter((p) => p.length > 0);
	const chunks = parts.map((p) => {
		const b = Buffer.from(p, "utf8");
		if (b.length > 63)
			throw new Error(`dns label too long: ${p.slice(0, 20)}…`);
		return Buffer.concat([Buffer.from([b.length]), b]);
	});
	chunks.push(Buffer.from([0]));
	return Buffer.concat(chunks);
}

/** Parse (and follow) a possibly-compressed name at `off`. */
export function parseName(
	buf: Buffer,
	off: number,
): { name: string; end: number } {
	const labels: string[] = [];
	let cur = off;
	let end = -1;
	for (let hops = 0; hops < 128; hops++) {
		const len = buf.readUInt8(cur);
		if (len === 0) {
			if (end < 0) end = cur + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			if (end < 0) end = cur + 2;
			cur = ((len & 0x3f) << 8) | buf.readUInt8(cur + 1);
			continue;
		}
		labels.push(buf.toString("utf8", cur + 1, cur + 1 + len));
		cur += 1 + len;
	}
	return { name: labels.join("."), end };
}

export interface DnsQuestion {
	name: string;
	type: number;
	cls: number;
}

/** The question section of an mDNS query (queries carry no records here). */
export function parseQuestions(buf: Buffer): DnsQuestion[] {
	const qd = buf.readUInt16BE(4);
	let off = 12;
	const out: DnsQuestion[] = [];
	for (let i = 0; i < qd; i++) {
		if (off + 4 > buf.length) break;
		const { name, end } = parseName(buf, off);
		if (end + 4 > buf.length) break;
		out.push({
			name,
			type: buf.readUInt16BE(end),
			cls: buf.readUInt16BE(end + 2),
		});
		off = end + 4;
	}
	return out;
}

/** PTR records from an answer section — the conflict detector's input. */
export function parseAnswerPtrs(buf: Buffer): string[] {
	const an = buf.readUInt16BE(6);
	let off = 12;
	// skip questions
	for (let i = 0; i < buf.readUInt16BE(4); i++) {
		const { end } = parseName(buf, off);
		off = end + 4;
	}
	const ptrs: string[] = [];
	for (let i = 0; i < an; i++) {
		const { end } = parseName(buf, off);
		const type = buf.readUInt16BE(end);
		const rdlen = buf.readUInt16BE(end + 8);
		const rdStart = end + 10;
		if (type === TYPE_PTR && rdStart + rdlen <= buf.length) {
			ptrs.push(parseName(buf, rdStart).name);
		}
		off = rdStart + rdlen;
	}
	return ptrs;
}

export interface DnsRecord {
	name: string;
	type: number;
	ttl: number;
	flush: boolean;
	rdata: Buffer;
}

export const ptrRdata = (target: string): Buffer => encodeName(target);
export const txtRdata = (kv: string[]): Buffer =>
	Buffer.concat(
		kv.map((s) => {
			const b = Buffer.from(s, "utf8");
			return Buffer.concat([Buffer.from([b.length]), b]);
		}),
	);
export const aRdata = (ip: string): Buffer => {
	const o = ip.split(".").map((s) => Number(s));
	if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
		throw new Error(`not an IPv4 address: ${ip}`);
	return Buffer.from(o);
};
export const srvRdata = (
	priority: number,
	weight: number,
	port: number,
	target: string,
): Buffer => {
	const b = Buffer.alloc(6);
	b.writeUInt16BE(priority, 0);
	b.writeUInt16BE(weight, 2);
	b.writeUInt16BE(port, 4);
	return Buffer.concat([b, encodeName(target)]);
};

const answer = (r: DnsRecord, flush: boolean): Buffer[] => [
	encodeName(r.name),
	(() => {
		const b = Buffer.alloc(10);
		b.writeUInt16BE(r.type, 0);
		// the CALLER's flush intent (announce yes, query response no) — not
		// the record-level flag: responses never carry the cache-flush bit
		b.writeUInt16BE((flush ? CACHE_FLUSH : 0) | CLASS_IN, 2);
		b.writeUInt32BE(r.ttl, 4);
		b.writeUInt16BE(r.rdata.length, 8);
		return b;
	})(),
	r.rdata,
];

/** The full announce packet: one response carrying the whole record set
 *  (QR=1 AA=1, cache-flush on the uniqueness records). */
export function buildAnnounce(recs: DnsRecord[]): Buffer {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(0x8400, 2); // QR=1, AA=1 (authoritative announcement)
	header.writeUInt16BE(recs.length, 6); // ANCOUNT
	return Buffer.concat([header, ...recs.flatMap((r) => answer(r, true))]);
}

/** A direct response: echo the questions, answer with the matching records. */
export function buildResponse(
	questions: DnsQuestion[],
	recs: DnsRecord[],
): Buffer {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(0x8400, 2); // QR=1, AA=1
	header.writeUInt16BE(questions.length, 4); // QDCOUNT
	header.writeUInt16BE(recs.length, 6); // ANCOUNT
	return Buffer.concat([
		header,
		...questions.flatMap((q) => [
			encodeName(q.name),
			(() => {
				const b = Buffer.alloc(4);
				b.writeUInt16BE(q.type, 0);
				b.writeUInt16BE(q.cls & ~QU_BIT, 2);
				return b;
			})(),
		]),
		...recs.flatMap((r) => answer(r, false)),
	]);
}

// --- the record set -------------------------------------------------------
/** The four records one hub advertises. addr undefined = skip the A record
 *  (the SRV target stays unresolvable; discovery degrades — never advertise
 *  127.0.0.1 to the LAN). */
export function recordsFor(cfg: AnnouncerConfig): DnsRecord[] {
	const svc = `${SERVICE_TYPE}.local`;
	const inst = `${cfg.label}.${svc}`;
	const host = `${cfg.hostname}.local`;
	const recs: DnsRecord[] = [
		{
			name: svc,
			type: TYPE_PTR,
			ttl: TTL_PTR,
			flush: false,
			rdata: ptrRdata(inst),
		},
		{
			name: inst,
			type: TYPE_SRV,
			ttl: TTL_UNIQUE,
			flush: true,
			rdata: srvRdata(0, 0, cfg.port, host),
		},
		{
			name: inst,
			type: TYPE_TXT,
			ttl: TTL_UNIQUE,
			flush: true,
			rdata: txtRdata(["klh=v1", "path=/"]),
		},
	];
	if (cfg.addr && cfg.addr !== "127.0.0.1")
		recs.push({
			name: host,
			type: TYPE_A,
			ttl: TTL_UNIQUE,
			flush: true,
			rdata: aRdata(cfg.addr),
		});
	return recs;
}

/** Best-effort primary LAN IPv4: the UDP-connect trick, then a scan of the
 *  host interfaces (host-networked container sees the device's own). */
export function detectAddr(): string | undefined {
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		let out: string | undefined;
		try {
			s.connect(53, "8.8.8.8");
			out = s.address().address;
		} finally {
			s.close();
		}
		if (out && out !== "0.0.0.0") return out;
	} catch {}
	for (const ifs of Object.values(os.networkInterfaces())) {
		for (const i of ifs ?? []) {
			if (i.family === "IPv4" && !i.internal) return i.address;
		}
	}
	return undefined;
}

// --- the announcer --------------------------------------------------------
export interface AnnouncerState {
	mode: "query" | "announce-only";
	announces: number;
	lastAt: number;
	addr?: string;
}

export interface AnnouncerHandle {
	cfg: AnnouncerConfig;
	state(): AnnouncerState;
	healthPort: number;
	stop(): Promise<void>;
}

const healthy = (st: AnnouncerState, intervalMs: number): boolean =>
	st.announces > 0 && Date.now() - st.lastAt < intervalMs * 2.5;

export function startAnnouncer(cfg: AnnouncerConfig): AnnouncerHandle {
	const recs = recordsFor(cfg);
	const st: AnnouncerState = {
		mode: "query",
		announces: 0,
		lastAt: 0,
		addr: cfg.addr,
	};
	const timers: NodeJS.Timeout[] = [];
	let closed = false;

	// tx socket: sends announcements + responses (ephemeral port, iface-bound)
	const tx = dgram.createSocket({ type: "udp4", reuseAddr: true });
	tx.bind(() => {
		tx.setMulticastTTL(255);
		tx.setMulticastInterface(cfg.addr ?? "0.0.0.0");
		// burst + cadence INSIDE the bind callback: the first announce never
		// races the multicast-interface assignment out the default interface
		announce();
		timers.push(setTimeout(announce, 1000));
		timers.push(setTimeout(announce, 2000));
		timers.push(setInterval(announce, cfg.intervalMs));
	});
	tx.on("error", (e) => console.error(`mdns tx: ${e.message}`));

	// rx socket: best-effort :5353 bind for query answering; on failure the
	// announcer degrades to announce-only (caches still populate — dns-sd
	// -B/-L answer from cached announcements).
	const rx = dgram.createSocket({ type: "udp4", reuseAddr: true });
	rx.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code === "EADDRINUSE" || e.code === "EACCES") {
			st.mode = "announce-only";
			console.log(
				`mdns: :5353 busy (${e.code}) — announce-only (cached announcements still discoverable)`,
			);
			try {
				rx.close();
			} catch {}
			return;
		}
		console.error(`mdns rx: ${e.message}`);
	});
	rx.on("message", (msg, rinfo) => {
		if (msg.length < 12) return;
		const flags = msg.readUInt16BE(2);
		if ((flags & 0x8000) !== 0) {
			// a response — conflict check: same instance, different source
			const inst = `${cfg.label}.${SERVICE_TYPE}.local`;
			for (const ptr of parseAnswerPtrs(msg)) {
				if (
					ptr.toLowerCase() === inst.toLowerCase() &&
					cfg.addr !== undefined &&
					rinfo.address !== cfg.addr
				)
					console.warn(
						`mdns: CONFLICT — ${inst} also announced by ${rinfo.address}`,
					);
			}
			return;
		}
		const qs = parseQuestions(msg);
		const matched = qs.filter(
			(q) =>
				q.type === TYPE_ANY ||
				recs.some(
					(r) =>
						r.name.toLowerCase() === q.name.toLowerCase() && r.type === q.type,
				),
		);
		if (matched.length === 0) return;
		const payload = buildResponse(qs, recs);
		const qu = qs.some((q) => (q.cls & QU_BIT) !== 0);
		if (qu) tx.send(payload, rinfo.port, rinfo.address, () => {});
		else tx.send(payload, MDNS_PORT, MDNS_GROUP, () => {});
	});

	const announce = (): void => {
		if (closed) return;
		tx.send(Buffer.from(buildAnnounce(recs)), MDNS_PORT, MDNS_GROUP, (err) => {
			if (err) return;
			st.announces++;
			st.lastAt = Date.now();
		});
	};
	// rapid announcement burst, then the steady cadence (RFC 6762 §8.3:
	// "at least two, one second apart") — scheduled INSIDE the tx bind
	// callback so the burst never races the multicast-interface assignment
	// out the default interface.

	// outside-process-verifiable state over HTTP (the mdns-health sidecar
	// polls THIS; compose health hits the sidecar)
	let server: ReturnType<typeof Bun.serve> | undefined;
	if (cfg.healthPort >= 0) {
		server = Bun.serve({
			port: cfg.healthPort,
			fetch: () => {
				const ok = healthy(st, cfg.intervalMs);
				const body = `${JSON.stringify(
					{
						...st,
						ok,
						label: cfg.label,
						hostname: cfg.hostname,
						port: cfg.port,
					},
					null,
					2,
				)}\n`;
				return new Response(body, {
					status: ok ? 200 : 503,
					headers: { "content-type": "application/json" },
				});
			},
		});
	}

	rx.bind(MDNS_PORT, () => {
		rx.addMembership(MDNS_GROUP, cfg.addr);
		rx.setMulticastInterface(cfg.addr ?? "0.0.0.0");
	});

	const stop = async (): Promise<void> => {
		closed = true;
		for (const t of timers) clearTimeout(t);
		// mDNS etiquette + cache hygiene: goodbye (TTL 0) for every record
		try {
			tx.send(
				Buffer.from(buildAnnounce(recs.map((r) => ({ ...r, ttl: 0 })))),
				MDNS_PORT,
				MDNS_GROUP,
			);
		} catch {}
		await new Promise<void>((res) => tx.close(() => res()));
		try {
			rx.close();
		} catch {}
		server?.stop(true);
	};

	return {
		cfg,
		state: () => ({ ...st }),
		healthPort: server?.port ?? cfg.healthPort,
		stop,
	};
}

// --- entry ----------------------------------------------------------------
if (import.meta.main) {
	const cfg = configFromEnv();
	// auto-detect BEFORE records are built: no detected address = the A
	// record is skipped entirely (never advertise 127.0.0.1 to the LAN)
	cfg.addr ??= detectAddr();
	const h = startAnnouncer(cfg);
	console.log(
		`mdns-announce: ${cfg.label} → _klh-hub._tcp ${cfg.hostname}.local:${cfg.port} (a=${cfg.addr ?? "auto"}, health :${h.healthPort})`,
	);
	const bye = (): void => {
		h.stop().then(() => process.exit(0));
	};
	process.on("SIGTERM", bye);
	process.on("SIGINT", bye);
}
