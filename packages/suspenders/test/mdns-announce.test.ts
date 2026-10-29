// test/mdns-announce.test.ts — W854: the hub's mDNS self-advertisement.
// Wire format (encode/parse round-trips), the record set (A record skipped
// without an address — never advertise 127.0.0.1), env config, a LIVE
// loopback announce+query round-trip, the compose wiring (host net, pinned
// image, outside-process health sidecar), and hubctl's knob plumbing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	aRdata,
	buildAnnounce,
	buildResponse,
	configFromEnv,
	encodeName,
	hostForLabel,
	parseAnswerPtrs,
	parseName,
	parseQuestions,
	recordsFor,
	srvRdata,
	startAnnouncer,
	txtRdata,
} from "../deploy/mdns/announce.ts";

setDefaultTimeout(20_000);

const baseCfg = {
	label: "nas-hub",
	port: 4101,
	addr: "127.0.0.1",
	hostname: "nas-hub",
	intervalMs: 250,
	healthPort: 0,
};

// --- wire format ----------------------------------------------------------
describe("dns wire format", () => {
	test("encodeName/parseName round-trip", () => {
		const buf = encodeName("nas-hub._klh-hub._tcp.local");
		expect(buf[0]).toBe(7);
		const { name, end } = parseName(buf, 0);
		expect(name).toBe("nas-hub._klh-hub._tcp.local");
		expect(end).toBe(buf.length);
	});

	test("parseName follows compression pointers", () => {
		const msg = Buffer.alloc(30);
		msg.set(encodeName("a.b"), 12);
		msg.writeUInt8(0xc0, 28);
		msg.writeUInt8(0x0c, 29);
		expect(parseName(msg, 28)).toEqual({ name: "a.b", end: 30 });
	});
});

describe("rdata builders", () => {
	test("srvRdata encodes prio/weight/port + target", () => {
		expect([...srvRdata(0, 0, 4101, "nas-hub.local")].slice(0, 6)).toEqual([
			0, 0, 0, 0, 0x10, 0x05,
		]);
	});

	test("aRdata/txtRdata byte layouts", () => {
		expect([...aRdata("127.0.0.1")]).toEqual([127, 0, 0, 1]);
		expect([...txtRdata(["klh=v1", "path=/"])]).toEqual([
			6, 107, 108, 104, 61, 118, 49, 6, 112, 97, 116, 104, 61, 47,
		]);
	});
});

describe("message builders", () => {
	test("parseQuestions walks the question section", () => {
		const head = Buffer.alloc(12);
		head.writeUInt16BE(2, 4); // QDCOUNT=2
		const wire = (name: string, type: number): Buffer =>
			Buffer.concat([
				encodeName(name),
				(() => {
					const b = Buffer.alloc(4);
					b.writeUInt16BE(type, 0);
					b.writeUInt16BE(0x0001, 2);
					return b;
				})(),
			]);
		const qs = parseQuestions(
			Buffer.concat([
				head,
				wire("_klh-hub._tcp.local", 12),
				wire("nas-hub.local", 1),
			]),
		);
		expect(qs).toHaveLength(2);
		expect(qs[0]?.name).toBe("_klh-hub._tcp.local");
		expect(qs[0]?.type).toBe(12);
		expect(qs[1]?.name).toBe("nas-hub.local");
		expect(qs[1]?.type).toBe(1);
	});
});

describe("announce + response packets", () => {
	test("buildAnnounce carries the record set; PTR parse-back names it", () => {
		const recs = recordsFor(baseCfg);
		const pkt = buildAnnounce(recs);
		expect(pkt.readUInt16BE(2) & 0x8000).toBeTruthy(); // QR=1
		expect(pkt.readUInt16BE(6)).toBe(recs.length); // ANCOUNT
		expect(parseAnswerPtrs(pkt)).toContain("nas-hub._klh-hub._tcp.local");
	});

	test("buildResponse echoes questions and answers the set", () => {
		const qs: DnsQuestion[] = [
			{ name: "_klh-hub._tcp.local", type: 12, cls: 0x0001 },
		];
		const recs = recordsFor(baseCfg);
		const pkt = buildResponse(qs, recs);
		expect(pkt.readUInt16BE(4)).toBe(1); // QDCOUNT
		expect(pkt.readUInt16BE(6)).toBe(recs.length); // ANCOUNT
		expect(parseAnswerPtrs(pkt)).toContain("nas-hub._klh-hub._tcp.local");
	});
});

describe("record set + config", () => {
	test("recordsFor: 4 records with a LAN address; A skipped without one", () => {
		const lan = recordsFor({ ...baseCfg, addr: "192.0.2.50" });
		expect(lan.map((r) => r.type)).toEqual([12, 33, 16, 1]);
		const noAddr = recordsFor({ ...baseCfg, addr: undefined });
		expect(noAddr.map((r) => r.type)).toEqual([12, 33, 16]);
	});

	test("recordsFor: loopback address also skips the A record", () => {
		const loopback = recordsFor({ ...baseCfg, addr: "127.0.0.1" });
		expect(loopback.map((r) => r.type)).toEqual([12, 33, 16]);
	});

	test("hostForLabel mirrors hub-locate's guessHost normalization", () => {
		expect(hostForLabel("NAS-Hub")).toBe("nas-hub");
		expect(hostForLabel("ikea hub!")).toBe("ikeahub");
		expect(hostForLabel("---")).toBe("---");
	});

	test("configFromEnv defaults + healthPort 0 escape hatch", () => {
		const cfg = configFromEnv({
			HUB_MDNS_LABEL: "nas-hub",
			HUB_MDNS_PORT: "4101",
			HUB_MDNS_HEALTH_PORT: "0",
		});
		expect(cfg.label).toBe("nas-hub");
		expect(cfg.port).toBe(4101);
		expect(cfg.healthPort).toBe(0);
		expect(cfg.hostname).toBe("nas-hub");
		expect(cfg.intervalMs).toBe(20_000);
	});
});

describe("live loopback round-trip", () => {
	test("announcer announces, answers PTR queries, serves health", async () => {
		const rx = dgram.createSocket({ type: "udp4", reuseAddr: true });
		const pkts: Buffer[] = [];
		rx.on("message", (m) => pkts.push(m));
		await new Promise<void>((res) => rx.bind(5353, () => res()));
		rx.addMembership("224.0.0.251", "127.0.0.1");
		const h = startAnnouncer({ ...baseCfg, intervalMs: 250, healthPort: 0 });
		await Bun.sleep(1200);
		// unsolicited announce (QDCOUNT=0, ANCOUNT>0) naming our instance
		const announce = pkts.find(
			(p) => p.readUInt16BE(4) === 0 && p.readUInt16BE(6) > 0,
		);
		expect(announce).toBeDefined();
		expect(parseAnswerPtrs(announce ?? Buffer.alloc(0))).toContain(
			"nas-hub._klh-hub._tcp.local",
		);
		// query leg: QM PTR question → multicast response (QDCOUNT=1)
		const tx = dgram.createSocket({ type: "udp4", reuseAddr: true });
		await new Promise<void>((res) =>
			tx.bind(() => {
				// keep the query leg on loopback — never multicast to the LAN
				tx.setMulticastInterface("127.0.0.1");
				res();
			}),
		);
		const q = Buffer.concat([
			(() => {
				const b = Buffer.alloc(12);
				b.writeUInt16BE(1, 4); // QDCOUNT=1
				return b;
			})(),
			encodeName("_klh-hub._tcp.local"),
			(() => {
				const b = Buffer.alloc(4);
				b.writeUInt16BE(12, 0); // PTR
				b.writeUInt16BE(0x0001, 2);
				return b;
			})(),
		]);
		tx.send(q, 5353, "224.0.0.251");
		await Bun.sleep(300);
		const resp = pkts.find(
			(p) => p.readUInt16BE(4) === 1 && p.readUInt16BE(6) > 0,
		);
		expect(resp).toBeDefined();
		expect(parseAnswerPtrs(resp ?? Buffer.alloc(0))).toContain(
			"nas-hub._klh-hub._tcp.local",
		);
		// self-report: real state, outside-process-verifiable
		const health = await fetch(`http://127.0.0.1:${h.healthPort}/healthz`);
		expect(health.status).toBe(200);
		const body = (await health.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.label).toBe("nas-hub");
		expect(body.port).toBe(4101);
		await h.stop();
		rx.close();
		tx.close();
	}, 15_000);
});

describe("hub-compose wiring", () => {
	const compose = Bun.YAML.parse(
		readFileSync(join(import.meta.dir, "../deploy/hub-compose.yaml"), "utf8"),
		{ merge: true },
	) as { services: Record<string, Record<string, unknown>> };
	const ann = compose.services["mdns-announce"];
	const health = compose.services["mdns-health"];

	test("mdns-announce: host net, pinned image, gate-gated, self-report port", () => {
		expect(ann?.network_mode).toBe("host");
		expect(ann?.image).toBe(compose.services["buckle-hub"]?.image);
		expect(ann?.depends_on).toEqual({
			"buckle-health": { condition: "service_healthy" },
		});
		expect(String(ann?.command)).toContain("deploy/mdns/announce.ts");
		expect(ann?.volumes).toContain("fleet-repo:/src/fleet:ro");
		const env = ann?.environment as Record<string, string>;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
		const portTpl = "${HUB_MDNS_PORT:-${HUB_BUCKLE_PORT:-4111}}";
		expect(env.HUB_MDNS_PORT).toBe(portTpl);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
		expect(env.HUB_MDNS_HEALTH_PORT).toBe("${HUB_MDNS_HEALTH_PORT:-4114}");
		expect(ann?.healthcheck).toBeUndefined(); // health hits the sidecar
	});

	test("mdns-health: outside-process probe polls the announcer", () => {
		expect(health?.network_mode).toBe("host");
		const cmd = String(health?.command);
		expect(cmd).toContain("healthcheck/probe.ts");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
		expect(cmd).toContain("${HUB_MDNS_HEALTH_PORT:-4114}/healthz");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
		expect(cmd).toContain("--listen ${HUB_MDNS_SIDECAR_PORT:-4115}");
	});
});

describe("hubctl plumbing", () => {
	const f = join(import.meta.dir, "fixtures-mdns-stack.json");
	test("render passes the mdns knobs to the hub .env", () => {
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"render",
				"w854",
			],
			{ env: { ...process.env, KLH_STACK: f } },
		);
		expect(r.exitCode).toBe(0);
		const out = r.stdout.toString();
		for (const line of [
			"HUB_MDNS_PORT=4101",
			"HUB_MDNS_ADDR=192.0.2.50",
			"HUB_MDNS_HOSTNAME=nas-hub",
			"HUB_MDNS_INTERVAL_MS=15000",
			"HUB_MDNS_HEALTH_PORT=4114",
			"HUB_MDNS_SIDECAR_PORT=4115",
		])
			expect(out).toContain(line);
	});
});
