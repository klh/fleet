// test/connect-egress.test.ts — W1260.2: the authenticated CONNECT egress.
// Unit laws: the SSRF matrix, allowlist boundary, authority parsing, Basic
// auth, the fail-closed config triad. E2E: app-shaped CONNECT through the
// loopback proxy reaches a fake upstream, holds a W1259 snapshot row while
// active and leaves it on close; every deny path + bounded op answers its
// own code (403/405/407/431/502/503) and the row disappears again.
import { afterEach, describe, expect, test } from "bun:test";
import {
	authAppOf,
	connectConfigOf,
	ConnectEgress,
	ConnectRegistry,
	type ConnectEgressOpts,
	destinationVerdict,
	hostMatchesAllow,
	isDeniedIp,
	parseAuthority,
	startConnectEgress,
} from "../src/connect-egress.ts";
import type { EgressSocket } from "../src/connect-egress.ts";
import type { ConnectPolicyBlock, GatewayPolicy } from "../src/policy.ts";

const TOKEN = "tok-w1260-2";
const ENV_KEYS = ["BUCKLE_CONNECT_TOKEN", "BUCKLE_CONNECT_PORT"];

afterEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
});

const policyOf = (over: Partial<ConnectPolicyBlock> = {}): GatewayPolicy => ({
	connect: { enabled: true, allow: ["api.openai.com"], ...over },
});

const envOf = (over: Record<string, string> = {}): Record<string, string> => ({
	BUCKLE_CONNECT_TOKEN: TOKEN,
	...over,
});

/** Distinct high port per test slot — no collisions with 410x faces. */
const testPort = (n: number): number =>
	14100 + ((process.pid * 31 + n * 17) % 800);

const basic = (user: string, pass: string): string =>
	`Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** Bind an echo server on a loopback ephemeral port; data bounces back. */
const echoUpstream = (): { port: number; stop: () => void } => {
	const l = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open: () => {},
			data: (s, d) => s.write(d),
			close: () => {},
			error: () => {},
		},
	});
	return { port: l.port, stop: () => l.stop(true) };
};

const mkEgress = (
	over: Partial<ConnectPolicyBlock>,
	opts: ConnectEgressOpts = {},
): ConnectEgress => {
	const cfg = connectConfigOf(policyOf(over), envOf());
	if (!cfg) throw new Error("test config unexpectedly inert");
	return new ConnectEgress(cfg, { connectTimeoutMs: 1500, ...opts }).start();
};

interface TunnelResult {
	status: string;
	sock: EgressSocket | null;
}

/** Raw CONNECT client: sends the request, resolves with the status line the
 *  moment "\r\n\r\n" arrives (tunnel stays open for the data phase). */
const openTunnel = (
	port: number,
	authority: string,
	auth: string | null,
	onData?: (d: Uint8Array) => void,
): Promise<TunnelResult> =>
	new Promise((res) => {
		let buf = "";
		let settled = false;
		const settle = (r: TunnelResult): void => {
			if (settled) return;
			settled = true;
			res(r);
		};
		void Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				data: (s, d) => {
					if (settled) {
						onData?.(d);
						return;
					}
					buf += new TextDecoder().decode(d);
					const i = buf.indexOf("\r\n\r\n");
					if (i >= 0) {
						settled = true;
						res({ status: buf.slice(0, i), sock: s as EgressSocket });
					}
				},
				close: () => settle({ status: buf, sock: null }),
				error: () => settle({ status: buf, sock: null }),
			},
		}).then(
			(s) => {
				const head = [
					`CONNECT ${authority} HTTP/1.1`,
					...(auth ? [`Proxy-Authorization: ${auth}`] : []),
				].join("\r\n");
				s.write(`${head}\r\n\r\n`);
			},
			() => settle({ status: "", sock: null }),
		);
	});

/** Poll until f() holds; throws on deadline (bounded test waits). */
const until = async (f: () => boolean, ms = 2000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!f()) {
		if (Date.now() > deadline) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 20));
	}
};

// ─── unit laws ──────────────────────────────────────────────────────────

describe("config triad (fail closed)", () => {
	test("missing any of enabled/token/allow → inert", () => {
		expect(connectConfigOf({}, {})).toBeNull();
		expect(connectConfigOf({ connect: { enabled: true } }, {})).toBeNull();
		expect(connectConfigOf(policyOf(), {})).toBeNull();
		expect(
			connectConfigOf(policyOf(), { BUCKLE_CONNECT_TOKEN: "" }),
		).toBeNull();
		expect(connectConfigOf(policyOf({ allow: [] }), envOf())).toBeNull();
	});

	test("full triad → defaults port 4103, 443-only, denyPrivate on", () => {
		const cfg = connectConfigOf(policyOf(), envOf());
		expect(cfg).not.toBeNull();
		if (!cfg) return;
		expect(cfg.enabled).toBe(true);
		expect(cfg.port).toBe(4103);
		expect(cfg.ports).toEqual([443]);
		expect(cfg.idleTimeoutMs).toBe(300_000);
		expect(cfg.maxTunnels).toBe(64);
		expect(cfg.denyPrivate).toBe(true);
	});

	test("env port override + deny_private:false + custom knobs", () => {
		const cfg = connectConfigOf(
			policyOf({ deny_private: false, idle_timeout_s: 5, max_tunnels: 2 }),
			envOf({ BUCKLE_CONNECT_PORT: "4150" }),
		);
		expect(cfg?.port).toBe(4150);
		expect(cfg?.denyPrivate).toBe(false);
		expect(cfg?.idleTimeoutMs).toBe(5000);
		expect(cfg?.maxTunnels).toBe(2);
	});
});

describe("port 4100 + malformed ports + empty ports", () => {
	test("fail loud / inert per the triad law", () => {
		expect(() => connectConfigOf(policyOf({ port: 4100 }), envOf())).toThrow(
			/4100/,
		);
		expect(() =>
			connectConfigOf(policyOf(), envOf({ BUCKLE_CONNECT_PORT: "x" })),
		).toThrow(/bad port/);
		expect(() =>
			connectConfigOf(policyOf(), envOf({ BUCKLE_CONNECT_PORT: "0" })),
		).toThrow(/bad port/);
		expect(connectConfigOf(policyOf({ ports: [] }), envOf())).toBeNull();
	});
});

describe("isDeniedIp (SSRF matrix)", () => {
	test("private/metadata/benchmark ranges deny", () => {
		for (const ip of [
			"127.0.0.1",
			"10.0.0.1", // scrub:allow — SSRF test vector, not a real host
			"172.16.0.9", // scrub:allow — SSRF test vector
			"192.168.1.1", // scrub:allow — SSRF test vector
			"169.254.169.254",
			"100.64.0.1",
			"198.18.0.5",
			"0.0.0.0",
			"224.0.0.1",
			"255.255.255.255",
			"::1",
			"::",
			"fe80::1",
			"fc00::1",
			"ff02::1",
			"2001:db8::1",
			"::ffff:127.0.0.1",
			"::ffff:10.0.0.1", // scrub:allow — SSRF test vector
			"not-an-ip",
		])
			expect(isDeniedIp(ip)).toBe(true);
	});

	test("public addresses and clean v4-mapped pass", () => {
		for (const ip of ["8.8.8.8", "1.1.1.1", "::ffff:8.8.8.8", "2606:4700::1"])
			expect(isDeniedIp(ip)).toBe(false);
	});
});

describe("hostMatchesAllow (suffix with boundary)", () => {
	test("exact + subdomain match; prefix lookalikes refuse", () => {
		expect(hostMatchesAllow("api.openai.com", ["api.openai.com"])).toBe(true);
		expect(hostMatchesAllow("a.api.openai.com", ["api.openai.com"])).toBe(true);
		expect(hostMatchesAllow("ChatGPT.COM", ["chatgpt.com"])).toBe(true);
		expect(hostMatchesAllow("x.chatgpt.com", ["*.chatgpt.com"])).toBe(true);
		expect(hostMatchesAllow("evil-chatgpt.com", ["chatgpt.com"])).toBe(false);
		expect(hostMatchesAllow("chatgpt.com.evil.io", ["chatgpt.com"])).toBe(
			false,
		);
		expect(hostMatchesAllow("openai.com", ["api.openai.com"])).toBe(false);
	});
});

describe("parseAuthority", () => {
	test("v4 host:port, bracketed v6, refusals", () => {
		expect(parseAuthority("api.openai.com:443")).toEqual({
			host: "api.openai.com",
			port: 443,
		});
		expect(parseAuthority("[::1]:443")).toEqual({ host: "[::1]", port: 443 });
		expect(parseAuthority("host:99999")).toBeNull();
		expect(parseAuthority("host")).toBeNull();
		expect(parseAuthority("a::b:443")).toBeNull();
		expect(parseAuthority(":443")).toBeNull();
		expect(parseAuthority("host:0")).toBeNull();
	});
});

describe("authAppOf (Basic username = app)", () => {
	test("known apps pass; buckle maps to unknown", () => {
		for (const app of ["claude", "chatgpt", "vscode", "codex"])
			expect(authAppOf(basic(app, TOKEN), TOKEN)).toBe(app);
		expect(authAppOf(basic("buckle", TOKEN), TOKEN)).toBe("unknown");
	});

	test("any mismatch → null (→ 407)", () => {
		expect(authAppOf(basic("claude", "wrong"), TOKEN)).toBeNull();
		expect(authAppOf(basic("evil", TOKEN), TOKEN)).toBeNull();
		expect(authAppOf(undefined, TOKEN)).toBeNull();
		expect(authAppOf("Bearer abc", TOKEN)).toBeNull();
		expect(authAppOf("Basic !!!not-base64!!!", TOKEN)).toBeNull();
		expect(authAppOf(basic("claude", TOKEN), "")).toBeNull();
	});
});

describe("destinationVerdict", () => {
	const cfg = {
		ports: [443],
		allow: ["api.openai.com", "127.0.0.1"],
		denyPrivate: true,
	};
	const deny = { ok: false as const, why: "" };

	test("port → allowlist → private, in order", async () => {
		await expect(
			destinationVerdict({ host: "api.openai.com", port: 80 }, cfg),
		).resolves.toEqual({ ...deny, why: "port" });
		await expect(
			destinationVerdict({ host: "evil.com", port: 443 }, cfg),
		).resolves.toEqual({ ...deny, why: "not-allowlisted" });
		await expect(
			destinationVerdict({ host: "127.0.0.1", port: 443 }, cfg),
		).resolves.toEqual({ ...deny, why: "private" });
	});
});

describe("destinationVerdict resolution paths", () => {
	const cfg = {
		ports: [443],
		allow: ["api.openai.com", "127.0.0.1"],
		denyPrivate: true,
	};
	const ok = { address: "93.184.216.34", family: 4 } as const;
	const deny = { ok: false as const, why: "" };

	test("clean resolution passes; mixed denies (rebinding guard)", async () => {
		const r = await destinationVerdict(
			{ host: "api.openai.com", port: 443 },
			cfg,
			async () => [ok],
		);
		expect(r).toEqual({ ok: true, ip: "93.184.216.34" });
		const mixed = await destinationVerdict(
			{ host: "api.openai.com", port: 443 },
			cfg,
			async () => [ok, { address: "10.0.0.1", family: 4 }], // scrub:allow — rebinding-guard vector
		);
		expect(mixed).toEqual({ ...deny, why: "private" });
	});
});

describe("destinationVerdict fail-closed + harness escape", () => {
	const cfg = {
		ports: [443],
		allow: ["api.openai.com", "127.0.0.1"],
		denyPrivate: true,
	};
	const deny = { ok: false as const, why: "" };

	test("failed/empty resolution denies (fail closed)", async () => {
		await expect(
			destinationVerdict(
				{ host: "api.openai.com", port: 443 },
				cfg,
				async () => {
					throw new Error("servfail");
				},
			),
		).resolves.toEqual({ ...deny, why: "resolve" });
		await expect(
			destinationVerdict(
				{ host: "api.openai.com", port: 443 },
				cfg,
				async () => [],
			),
		).resolves.toEqual({ ...deny, why: "resolve" });
	});

	test("denyPrivate:false lets a literal loopback through (E2E harness law)", async () => {
		const r = await destinationVerdict(
			{ host: "127.0.0.1", port: 443 },
			{ ...cfg, denyPrivate: false },
		);
		expect(r).toEqual({ ok: true, ip: "127.0.0.1" });
	});
});

describe("registry (W1259 snapshot contract)", () => {
	test("open/close/deny + snapshot shape and copies", () => {
		const reg = new ConnectRegistry();
		const row = {
			id: "t1",
			host: "api.openai.com",
			port: 443,
			app: "claude" as const,
			openedAt: 1,
			bytesUp: 0,
			bytesDown: 0,
			state: "held" as const,
		};
		reg.open(row);
		expect(reg.size).toBe(1);
		const snap = reg.snapshot();
		expect(snap.count).toBe(1);
		expect(snap.held[0]).toEqual(row);
		row.bytesUp = 99; // mutate AFTER the snapshot — the copy must stay frozen
		expect(snap.held[0]?.bytesUp).toBe(0);
		expect(reg.snapshot().held[0]?.bytesUp).toBe(99); // registry sees live
		reg.close("t1");
		expect(reg.size).toBe(0);
		const empty = reg.snapshot();
		expect(empty.count).toBe(0);
		expect(empty.held).toEqual([]);
		reg.deny("not-allowlisted");
		reg.deny("not-allowlisted");
		expect(reg.deniedOf("not-allowlisted")).toBe(2);
		expect(reg.totals).toEqual({ opened: 1, closed: 1, denied: 2 });
	});
});

// ─── E2E: raw-socket CONNECT against live legs ──────────────────────────

describe("CONNECT E2E: happy path", () => {
	test("claude tunnel holds a W1259 row while active", async () => {
		const up = echoUpstream();
		const egress = mkEgress(
			{ port: testPort(1), ports: [up.port], deny_private: false },
			{ resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		);
		const t = await openTunnel(
			egress.port,
			`api.openai.com:${up.port}`,
			basic("claude", TOKEN),
		);
		expect(t.status).toContain("200");
		expect(t.sock).not.toBeNull();
		await until(() => egress.registry.snapshot().count === 1);
		expect(egress.registry.snapshot().held[0]).toMatchObject({
			host: "api.openai.com",
			port: up.port,
			app: "claude",
			state: "held",
		});
		t.sock?.end();
		await until(() => egress.registry.snapshot().count === 0);
		egress.stop();
		up.stop();
	});
});

describe("CONNECT E2E: byte counts", () => {
	test("app bytes splice both directions and land in the row", async () => {
		const up = echoUpstream();
		const egress = mkEgress(
			{ port: testPort(2), ports: [up.port], deny_private: false },
			{ resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		);
		let down = "";
		const t = await openTunnel(
			egress.port,
			`api.openai.com:${up.port}`,
			basic("chatgpt", TOKEN),
			(d) => {
				down += new TextDecoder().decode(d);
			},
		);
		expect(t.status).toContain("200");
		t.sock?.write("hello-tls");
		await until(
			() =>
				down.includes("hello-tls") &&
				(egress.registry.snapshot().held[0]?.bytesDown ?? 0) >= 9,
		);
		const row = egress.registry.snapshot().held[0];
		expect(row?.bytesUp).toBe(9);
		expect(row?.app).toBe("chatgpt");
		t.sock?.end();
		egress.stop();
		up.stop();
	});
});

describe("CONNECT E2E: auth denies", () => {
	const mk = (): { egress: ConnectEgress; stop: () => void } => {
		const egress = mkEgress({ port: testPort(3), ports: [443] });
		return { egress, stop: () => egress.stop() };
	};

	test("bad token / missing auth / unknown app → 407", async () => {
		const { egress, stop } = mk();
		const bad = await openTunnel(
			egress.port,
			"api.openai.com:443",
			basic("claude", "wrong"),
		);
		expect(bad.status).toContain("407");
		const none = await openTunnel(egress.port, "api.openai.com:443", null);
		expect(none.status).toContain("407");
		const evil = await openTunnel(
			egress.port,
			"api.openai.com:443",
			basic("evil", TOKEN),
		);
		expect(evil.status).toContain("407");
		stop();
	});
});

describe("CONNECT E2E: destination denies", () => {
	const mk = (over: Partial<ConnectPolicyBlock> = {}): ConnectEgress =>
		mkEgress({ port: testPort(4), ports: [443], ...over });

	test("wrong port / not-allowlisted / private literal → 403", async () => {
		const egress = mk();
		const port = await openTunnel(
			egress.port,
			"api.openai.com:8443",
			basic("codex", TOKEN),
		);
		expect(port.status).toContain("403");
		const host = await openTunnel(
			egress.port,
			"evil.com:443",
			basic("codex", TOKEN),
		);
		expect(host.status).toContain("403");
		const priv = await openTunnel(
			egress.port,
			"127.0.0.1:443",
			basic("codex", TOKEN),
		);
		expect(priv.status).toContain("403");
		egress.stop();
	});

	test("metadata IP via allowlisted-looking literal → 403 (denyPrivate)", async () => {
		const egress = mk({ allow: ["169.254.169.254"] });
		const meta = await openTunnel(
			egress.port,
			"169.254.169.254:443",
			basic("claude", TOKEN),
		);
		expect(meta.status).toContain("403");
		egress.stop();
	});

	test("non-CONNECT method → 405; portless/bad authority → 400", async () => {
		const egress = mk();
		const get = await openTunnel(egress.port, "GET / HTTP/1.1", null);
		expect(get.status).toContain("405");
		const bad = await openTunnel(
			egress.port,
			"host:99999",
			basic("claude", TOKEN),
		);
		expect(bad.status).toContain("400");
		egress.stop();
	});
});

describe("CONNECT E2E: capacity", () => {
	const boot = (): {
		egress: ConnectEgress;
		stop: () => void;
		port: number;
	} => {
		const up = echoUpstream();
		const egress = mkEgress(
			{
				port: testPort(5),
				ports: [up.port],
				deny_private: false,
				max_tunnels: 1,
			},
			{ resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		);
		return {
			egress,
			up,
			stop: () => {
				egress.stop();
				up.stop();
			},
		};
	};
	const dial = (egress: ConnectEgress, port: number): Promise<TunnelResult> =>
		openTunnel(egress.port, `api.openai.com:${port}`, basic("claude", TOKEN));

	test("second CONNECT while full → 503", async () => {
		const { egress, up, stop } = boot();
		const t1 = await dial(egress, up.port);
		expect(t1.status).toContain("200");
		await until(() => egress.registry.snapshot().count === 1);
		const t2 = await dial(egress, up.port);
		expect(t2.status).toContain("503");
		t1.sock?.end();
		egress.stop();
		stop();
	});

	test("freed slot reopens", async () => {
		const { egress, up, stop } = boot();
		const t1 = await dial(egress, up.port);
		expect(t1.status).toContain("200");
		t1.sock?.end();
		await until(() => egress.registry.snapshot().count === 0);
		const t3 = await dial(egress, up.port);
		expect(t3.status).toContain("200");
		t3.sock?.end();
		egress.stop();
		stop();
	});
});

describe("CONNECT E2E: dead upstream", () => {
	test("unconnectable destination → 502", async () => {
		const egress = mkEgress(
			{ port: testPort(6), ports: [44444], deny_private: false },
			{ resolve: async () => [{ address: "127.0.0.2", family: 4 }] },
		);
		const t = await openTunnel(
			egress.port,
			"api.openai.com:44444",
			basic("claude", TOKEN),
		);
		expect(t.status).toContain("502");
		egress.stop();
	});
});

describe("CONNECT E2E: header flood", () => {
	test("past the 8KB cap without a terminator → 431", async () => {
		const egress = mkEgress({ port: testPort(7), ports: [443] });
		const status = await new Promise<string>((res) => {
			void Bun.connect({
				hostname: "127.0.0.1",
				port: egress.port,
				socket: {
					data: (s, d) => {
						res(new TextDecoder().decode(d));
						s.end();
					},
					close: () => res(""),
					error: () => res(""),
				},
			}).then((s) => {
				s.write(`CONNECT api.openai.com:443 HTTP/1.1\r\n${"a".repeat(9000)}`);
			});
		});
		expect(status).toContain("431");
		egress.stop();
	});
});

describe("CONNECT E2E: idle timeout", () => {
	test("held tunnel with no traffic tears down", async () => {
		const up = echoUpstream();
		const egress = mkEgress(
			{
				port: testPort(8),
				ports: [up.port],
				deny_private: false,
				idle_timeout_s: 1,
			},
			{ resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		);
		const t = await openTunnel(
			egress.port,
			`api.openai.com:${up.port}`,
			basic("claude", TOKEN),
		);
		expect(t.status).toContain("200");
		await until(() => egress.registry.snapshot().count === 1);
		await until(() => egress.registry.snapshot().count === 0, 4000);
		egress.stop();
		up.stop();
	});
});

describe("startConnectEgress (boot seam)", () => {
	test("inert without the triad; live on BUCKLE_CONNECT_PORT when enabled", () => {
		expect(startConnectEgress({}, 4101)).toBeUndefined();
		expect(startConnectEgress(policyOf(), {})).toBeUndefined();
		process.env.BUCKLE_CONNECT_TOKEN = TOKEN;
		process.env.BUCKLE_CONNECT_PORT = String(testPort(9));
		const egress = startConnectEgress(policyOf(), 4101);
		expect(egress).toBeDefined();
		expect(egress?.port).toBe(testPort(9));
		egress?.stop();
	});

	test("refuses a port collision with the buckle serve face", () => {
		process.env.BUCKLE_CONNECT_TOKEN = TOKEN;
		const p = testPort(9);
		expect(() => startConnectEgress(policyOf({ port: p }), p)).toThrow(
			/collides/,
		);
	});
});
