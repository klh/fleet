// test/remotes.test.ts — hooks/lib/remotes.ts: config loading, DNS-first
// resolution with ip_fallback, protocol probes, and openai chat routing —
// proven against a real local stub server (Bun.serve), not mocks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	authHeaders,
	chatRemote,
	configPath,
	endpointUrl,
	ensureEndpoint,
	endpointsWithRole,
	loadRemotes,
	probeEndpoint,
	type RemoteEndpoint,
	type RemoteMachine,
	resolveHost,
	sendWoL,
} from "../hooks/lib/remotes.ts";

// ─── stub remote: an openai-shaped endpoint on 127.0.0.1 ──────────────────
const HITS: string[] = [];
const stub = Bun.serve({
	port: 0, // OS-assigned
	fetch(req) {
		const url = new URL(req.url);
		HITS.push(url.pathname);
		if (url.pathname === "/v1/models")
			return Response.json({ data: [{ id: "stub-model" }] });
		if (url.pathname === "/v1/chat/completions")
			return Response.json({
				choices: [{ message: { content: "STUB-ANSWER" } }],
			});
		return new Response("nope", { status: 404 });
	},
});

// ─── tls stub: a REAL self-signed HTTPS server bound to localhost — proves
// tls machines route by hostname (SNI), matching z.ai's CDN edge, which
// 421s any request arriving by raw IP with no SNI/Host match. The
// self-signed cert needs NODE_TLS_REJECT_UNAUTHORIZED=0, scoped to this
// file's tests only (restored in afterAll).
const certDir = mkdtempSync(`${tmpdir()}/suspenders-remotes-tls-`);
Bun.spawnSync([
	"openssl",
	"req",
	"-x509",
	"-newkey",
	"rsa:2048",
	"-nodes",
	"-subj",
	"/CN=localhost",
	"-keyout",
	`${certDir}/key.pem`,
	"-out",
	`${certDir}/cert.pem`,
	"-days",
	"1",
]);
const TLS_HITS: string[] = [];
const TLS_AUTH_HEADERS: (string | null)[] = [];
const tlsStub = Bun.serve({
	port: 0,
	tls: {
		cert: readFileSync(`${certDir}/cert.pem`),
		key: readFileSync(`${certDir}/key.pem`),
	},
	fetch(req) {
		const url = new URL(req.url);
		TLS_HITS.push(url.pathname);
		TLS_AUTH_HEADERS.push(req.headers.get("authorization"));
		if (url.pathname === "/v1/models")
			return Response.json({ data: [{ id: "tls-model" }] });
		if (url.pathname === "/v1/chat/completions")
			return Response.json({
				choices: [{ message: { content: "TLS-ANSWER" } }],
			});
		return new Response("nope", { status: 404 });
	},
});

// ─── fixture config: HOME pointed at a temp dir ───────────────────────────
const TMP = mkdtempSync(`${tmpdir()}/suspenders-remotes-home-`);
const EP: RemoteEndpoint = {
	port: stub.port,
	protocol: "openai",
	roles: ["general", "advise"],
	model: "stub-model",
	keepwarm_probe: true,
};
const MACHINE: RemoteMachine = {
	name: "stub",
	host: "stub.invalid", // unresolvable → forces the ip_fallback path
	ip_fallback: "127.0.0.1",
	endpoints: [EP],
};
const TLS_EP: RemoteEndpoint = {
	port: tlsStub.port,
	protocol: "openai",
	roles: ["general"],
	model: "tls-model",
	tls: true, // tls now lives on the endpoint, not the machine
	api_key: "secret-token",
};
const TLS_MACHINE: RemoteMachine = {
	name: "cdn",
	host: "localhost", // tls:true → must stay the hostname, never resolved
	endpoints: [TLS_EP],
};

const REAL_TLS_REJECT = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(() => {
	mkdirSync(`${TMP}/.claude/local-llm`, { recursive: true });
	process.env.HOME = TMP;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed test cert only
	writeFileSync(
		configPath(),
		JSON.stringify({ machines: [MACHINE, TLS_MACHINE] }),
	);
});

afterAll(() => {
	stub.stop(true);
	tlsStub.stop(true);
	rmSync(TMP, { recursive: true, force: true });
	rmSync(certDir, { recursive: true, force: true });
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = REAL_TLS_REJECT;
	if (REAL_HOME) process.env.HOME = REAL_HOME;
});

/** configPath() reads HOME at call time — the fixture points HOME at TMP for
 *  this file's tests and afterAll restores the real one (a leaked HOME
 *  poisons later test files that assert against $HOME paths). */
const REAL_HOME = process.env.HOME;

describe("remotes registry", () => {
	test("configPath follows HOME", () => {
		expect(configPath()).toBe(`${TMP}/.claude/local-llm/remotes.json`);
	});

	test("loadRemotes parses the fixture", () => {
		expect(loadRemotes()).toHaveLength(2);
		expect(endpointsWithRole("advise")).toHaveLength(1);
	});

	test("resolveHost falls back when DNS fails", async () => {
		const ip = await resolveHost("stub.invalid", "127.0.0.1");
		expect(ip).toBe("127.0.0.1");
	});

	test("probeEndpoint reports alive with latency", async () => {
		const h = await probeEndpoint(MACHINE, EP);
		expect(h.alive).toBe(true);
		expect(h.ms).toBeGreaterThanOrEqual(0);
		expect(HITS).toContain("/v1/models");
	});

	test("chatRemote routes and returns the answer", async () => {
		const out = await chatRemote(MACHINE, EP, [
			{ role: "user", content: "hello" },
		]);
		expect(out.text).toBe("STUB-ANSWER");
		expect(out.model).toBe("stub-model");
		expect(HITS).toContain("/v1/chat/completions");
	});

	test("ensureEndpoint without mac returns probe result", async () => {
		const h = await ensureEndpoint(MACHINE, EP);
		expect(h.alive).toBe(true);
	});

	test("dead endpoint probes dead", async () => {
		const dead: RemoteMachine = {
			name: "dead",
			host: "dead.invalid",
			ip_fallback: "127.0.0.1",
			endpoints: [{ port: 1, protocol: "openai", roles: [] }],
		};
		const ep = dead.endpoints[0];
		if (!ep) throw new Error("fixture");
		const h = await probeEndpoint(dead, ep);
		expect(h.alive).toBe(false);
	});

	test("sendWoL rejects a malformed MAC without sending", async () => {
		expect(await sendWoL("not-a-mac", "127.0.0.1:9")).toBe(false);
	});

	test("endpointUrl: https+hostname for tls, http+ip otherwise, base overrides both", () => {
		expect(endpointUrl("1.2.3.4", { tls: undefined, port: 8080 }, "/x")).toBe(
			"http://1.2.3.4:8080/x",
		);
		expect(
			endpointUrl("api.z.ai", { tls: true, port: 443 }, "/v1/models"),
		).toBe("https://api.z.ai:443/v1/models");
		expect(
			endpointUrl(
				"ignored",
				{ base: "https://edge.example.com/prefix/", port: 1 },
				"/v1/models",
			),
		).toBe("https://edge.example.com/prefix/v1/models");
	});

	test("authHeaders: protocol-aware, empty when no key configured", () => {
		expect(authHeaders(EP)).toEqual({});
		expect(authHeaders(TLS_EP)).toEqual({
			Authorization: "Bearer secret-token",
		});
		expect(
			authHeaders({
				port: 1,
				protocol: "immich",
				roles: [],
				api_key: "immich-key",
			}),
		).toEqual({ "x-api-key": "immich-key" });
	});

	test("tls machine (CDN-fronted) keeps the hostname for SNI — real TLS handshake, self-signed cert", async () => {
		const probe = await probeEndpoint(TLS_MACHINE, TLS_EP);
		expect(probe.alive).toBe(true);
		expect(TLS_HITS).toContain("/v1/models");

		const out = await chatRemote(TLS_MACHINE, TLS_EP, [
			{ role: "user", content: "hello" },
		]);
		expect(out.text).toBe("TLS-ANSWER");
		expect(TLS_HITS).toContain("/v1/chat/completions");
		expect(TLS_AUTH_HEADERS).toContain("Bearer secret-token");
	});
	test("loadRemotes fails loud (returns []) on a schema-invalid config", () => {
		const bad = configPath();
		const original = readFileSync(bad, "utf8");
		writeFileSync(
			bad,
			JSON.stringify({ machines: [{ name: "broken", endpoints: "nope" }] }),
		);
		expect(loadRemotes()).toEqual([]);
		writeFileSync(bad, original);
	});
});
