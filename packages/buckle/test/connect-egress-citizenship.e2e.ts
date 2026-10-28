// test/connect-egress-citizenship.e2e.ts — W2173.7 HTTP citizenship on the
// CONNECT egress: UA on every HTTP answer the egress writes (200 + denies),
// schema-validated request line/authority/credential, AbortSignal-owned dial
// deadline (x-request-deadline propagation), clampRetryAfter-bounded backoff.
import { expect, test } from "@playwright/test";
import {
	CONNECT_EGRESS_UA,
	connectConfigOf,
	ConnectEgress,
	ConnectRequestLineSchema,
	ProxyAuthorizationSchema,
	type ConnectEgressOpts,
	dialBackoffMs,
	dialBudgetMs,
	parseAuthority,
} from "../src/connect-egress.ts";
import type { ConnectPolicyBlock, GatewayPolicy } from "../src/policy.ts";
import { openTunnel, until } from "./connect-tunnel.ts";

const TOKEN = "tok-w2173-7";
const testPort = (n: number): number =>
	15100 + ((process.pid * 37 + n * 19) % 700);

const policyOf = (over: Partial<ConnectPolicyBlock> = {}): GatewayPolicy => ({
	connect: { enabled: true, allow: ["api.openai.com"], ...over },
});

/** Egress over a schema-parsed config (the ConnectTunnelConfig shape). */
const mkEgress = (
	port: number,
	over: Partial<ConnectPolicyBlock> = {},
	opts: ConnectEgressOpts = {},
): ConnectEgress => {
	const block: ConnectPolicyBlock = {
		enabled: true,
		port,
		ports: [443],
		...over,
	};
	const cfg = connectConfigOf(policyOf(block), { BUCKLE_CONNECT_TOKEN: TOKEN });
	if (!cfg) throw new Error("test config unexpectedly inert");
	return new ConnectEgress(cfg, { connectTimeoutMs: 1500, ...opts }).start();
};

test.describe("dial citizenship units (W2173.7) @unit", () => {
	test("dialBackoffMs is clamp-bounded; attempt 0 never sleeps", () => {
		expect(dialBackoffMs(1, 1, 3)).toBe(1000);
		expect(dialBackoffMs(2, 1, 3)).toBe(2000);
		expect(dialBackoffMs(5, 1, 3)).toBe(3000);
		expect(dialBackoffMs(0, 1, 3)).toBe(0);
	});

	test("dialBudgetMs honors a tighter caller deadline, ignores junk", () => {
		expect(dialBudgetMs(5000, undefined)).toBe(5000);
		const t0 = Date.now();
		expect(dialBudgetMs(5000, String(t0 + 1500), () => t0)).toBe(1500);
		expect(dialBudgetMs(5000, String(t0 - 10), () => t0)).toBe(0);
	});

	test("authority / request-line / credential schemas refuse junk", () => {
		expect(parseAuthority("[::1]:443")).toEqual({ host: "[::1]", port: 443 });
		expect(parseAuthority("h:99999")).toBe(null);
		expect(ConnectRequestLineSchema.safeParse("GET / HTTP/1.1").success).toBe(
			false,
		);
		expect(
			ConnectRequestLineSchema.safeParse("CONNECT h:443 HTTP/1.1").success,
		).toBe(true);
		expect(ProxyAuthorizationSchema.safeParse("Basic aGk6").success).toBe(true);
		expect(ProxyAuthorizationSchema.safeParse("Bearer x").success).toBe(false);
	});
});

// ─── E2E: the UA rides every HTTP answer the egress writes ──────────────

test.describe("CONNECT E2E: UA citizenship (W2173.7) @api", () => {
	test("deny answer carries the egress UA", async () => {
		const egress = mkEgress(testPort(1));
		const t = await openTunnel(egress.port, "api.openai.com:443", null);
		expect(t.status).toContain("407");
		expect(t.status).toContain(`user-agent: ${CONNECT_EGRESS_UA}`);
		egress.stop();
	});
});

test.describe("CONNECT E2E: UA on the tunnel head (W2173.7) @api", () => {
	test("200 answer carries the UA; the tunnel still splices bytes", async () => {
		const up = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: () => {},
				data: (s, d) => {
					s.write(d);
				},
				close: () => {},
				error: () => {},
			},
		});
		const egress = mkEgress(
			testPort(2),
			{ ports: [up.port], deny_private: false },
			{ resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		);
		let down = "";
		const t = await openTunnel(
			egress.port,
			`api.openai.com:${up.port}`,
			`Basic ${Buffer.from(`claude:${TOKEN}`).toString("base64")}`,
			(d) => {
				down += new TextDecoder().decode(d);
			},
		);
		expect(t.status).toContain("200");
		expect(t.status).toContain(`user-agent: ${CONNECT_EGRESS_UA}`);
		t.sock?.write("ping");
		await until(() => down.includes("ping"));
		t.sock?.end();
		up.stop(true);
		egress.stop();
	});
});
