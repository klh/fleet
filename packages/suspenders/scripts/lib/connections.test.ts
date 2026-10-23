// W1234 — connections.ts tests: precedence, longest-prefix boundary, app
// filtering, 600-mode write, no-secrets assertion, schema refusals. All
// tmp-scoped; the known-hub set is injected, never the machine registry.
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
	type ConnectionsConfig,
	assertNoSecrets,
	enabledAppsOf,
	facePairs,
	loadConnections,
	longestPrefixHub,
	preferPin,
	proxyBaseOf,
	resolveHubForPath,
	singboxConfig,
	writeDefaultConfig,
} from "./connections.ts";

const cfg = (over: Partial<ConnectionsConfig> = {}): ConnectionsConfig => ({
	version: 1,
	default: "home",
	apps: {
		claude: { enabled: true },
		chatgpt: { enabled: false },
		vscode: { enabled: true },
	},
	repos: {},
	...over,
});

const KNOWN = ["home", "ikea", "nas"];

test("prefer-pin beats repos beats default", () => {
	const root = mkdtempSync(join(tmpdir(), "conn-test-"));
	try {
		writeFileSync(join(root, ".prefer"), "hub=ikea\n");
		const c = cfg({
			repos: { [root]: "nas" },
		});
		const r = resolveHubForPath(root, c, KNOWN);
		expect(r.hub).toBe("ikea");
		expect(r.via).toBe("prefer-pin");
		expect(r.source).toContain(".prefer");
		// the pin covers the whole subtree (walk-up law)
		const child = join(root, "sub");
		mkdirSync(child);
		const rSub = resolveHubForPath(child, c, KNOWN);
		expect(rSub.hub).toBe("ikea");
		expect(rSub.via).toBe("prefer-pin");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repos override beats default when no pin applies", () => {
	const plain = mkdtempSync(join(tmpdir(), "conn-plain-"));
	try {
		// no .prefer anywhere above plain — the repos prefix decides
		const c = cfg({ repos: { [plain]: "nas" } });
		const r = resolveHubForPath(join(plain, "sub"), c, KNOWN);
		expect(r.hub).toBe("nas");
		expect(r.via).toBe("repos");
		// outside every override → default
		expect(resolveHubForPath("/tmp", cfg(), KNOWN)).toEqual({
			hub: "home",
			via: "default",
		});
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
});

test("routing-plane prefer expr first token pins a known hub", () => {
	const root = mkdtempSync(join(tmpdir(), "conn-test-"));
	try {
		writeFileSync(join(root, ".prefer"), 'prefer = "ikea llms"\n');
		expect(preferPin(root, KNOWN)?.hub).toBe("ikea");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("walk-up: a .prefer above the repo pins the subtree", () => {
	const root = mkdtempSync(join(tmpdir(), "conn-test-"));
	try {
		writeFileSync(join(root, ".prefer"), "hub=nas\n");
		const deep = join(root, "a", "b");
		mkdirSync(deep, { recursive: true });
		expect(preferPin(deep, KNOWN)?.hub).toBe("nas");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("longest-prefix wins and the boundary is separator-safe", () => {
	const repos = {
		"/tmp/t/a": "nas",
		"/tmp/t/a/b": "ikea",
		"/tmp/t/ab": "home",
	};
	expect(longestPrefixHub(repos, "/tmp/t/a/b/c")?.hub).toBe("ikea");
	expect(longestPrefixHub(repos, "/tmp/t/a/c")?.hub).toBe("nas");
	// /tmp/t/ab must NOT match a path under /tmp/t/a
	expect(longestPrefixHub(repos, "/tmp/t/abc")).toBeNull();
	expect(longestPrefixHub(repos, "/elsewhere")).toBeNull();
	// exact-equality match (the path IS the repo root)
	expect(longestPrefixHub(repos, "/tmp/t/a")?.hub).toBe("nas");
});

test("app filtering: faces only carry enabled apps", () => {
	const c = cfg();
	expect(enabledAppsOf(c)).toEqual(["claude", "vscode"]);
	// claude enabled → ANTHROPIC_BASE_URL rides the faces
	const url = "http://hub.local:4101";
	expect(
		facePairs(["claude"], url).some((p) => p.key === "ANTHROPIC_BASE_URL"),
	).toBe(true);
	// claude disabled → no ANTHROPIC_BASE_URL, proxy vars stay
	const pairs2 = facePairs(["vscode"], url);
	expect(pairs2.some((p) => p.key === "ANTHROPIC_BASE_URL")).toBe(false);
	expect(pairs2.some((p) => p.key === "HTTPS_PROXY")).toBe(true);
	// --app filter narrows; a disabled --app yields nothing
	expect(enabledAppsOf(c, "vscode")).toEqual(["vscode"]);
	expect(enabledAppsOf(c, "chatgpt")).toEqual([]);
});

test("sing-box rules only for enabled apps; hub outbound = hub url", () => {
	const url = "http://hub.local:4101";
	const sb = singboxConfig(["claude", "vscode"], url);
	const rules = (sb.route as { rules: Array<Record<string, unknown>> }).rules;
	const blob = JSON.stringify(rules);
	expect(blob).toContain("Claude");
	expect(blob).toContain("Visual Studio Code");
	expect(blob).not.toContain("ChatGPT");
	const sb2 = singboxConfig(["chatgpt"], url);
	expect(JSON.stringify(sb2)).toContain("ChatGPT");
	const outbounds = sb.outbounds as Array<Record<string, unknown>>;
	expect(outbounds[0]).toMatchObject({
		type: "http",
		tag: "hub",
		server: "hub.local",
		port: 4101,
	});
	// final: direct — the TUN routes the apps, never the whole machine
	expect((sb.route as { final: string }).final).toBe("direct");
});

test("writeDefaultConfig lands at mode 600", () => {
	const root = mkdtempSync(join(tmpdir(), "conn-test-"));
	try {
		const p = join(root, "cfg", "connections.json");
		writeDefaultConfig(p, cfg());
		expect(statSync(p).mode & 0o777).toBe(0o600);
		// the written file loads back clean
		const load = loadConnections(p);
		expect(load.ok).toBe(true);
		if (load.ok) expect(load.mode).toBe(0o600);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no-secrets assertion trips on key material and passes clean faces", () => {
	// fixture shapes assemble at runtime — never a literal key-shaped string
	// (the scrub/gitleaks gates are right to refuse those)
	const sk = ["sk-", "abc1234567890123456"].join("");
	const bksk = ["bksk_", "abcdefghijklmnop"].join("");
	const akia = ["AK", "IAIOSFODNN7EXAMPLE"].join("");
	const pem = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
	expect(() => assertNoSecrets(`token ${sk} here`)).toThrow();
	expect(() => assertNoSecrets(`key ${bksk} end`)).toThrow();
	expect(() => assertNoSecrets(`id ${akia}`)).toThrow();
	expect(() => assertNoSecrets(`head ${pem} body`)).toThrow();
	const clean = facePairs(["claude"], "http://hub.local:4101")
		.map((p) => `${p.key}=${p.value}`)
		.join("\n");
	expect(() => assertNoSecrets(clean)).not.toThrow();
});

test("schema refusals: unknown keys, bad version, bad rows", () => {
	const root = mkdtempSync(join(tmpdir(), "conn-test-"));
	try {
		const p = join(root, "connections.json");
		// unknown top-level key carrying a key-shaped value — refused
		const smuggled = ["sk-", "abc12345678901234567"].join("");
		writeFileSync(p, JSON.stringify({ ...cfg(), token: smuggled }));
		expect(loadConnections(p).ok).toBe(false);
		writeFileSync(p, JSON.stringify({ ...cfg(), version: 2 }));
		expect(loadConnections(p).ok).toBe(false);
		writeFileSync(
			p,
			JSON.stringify({ ...cfg(), apps: { slack: { enabled: true } } }),
		);
		expect(loadConnections(p).ok).toBe(false);
		writeFileSync(p, JSON.stringify({ ...cfg(), repos: { "/x": 42 } }));
		expect(loadConnections(p).ok).toBe(false);
		writeFileSync(p, "not json");
		expect(loadConnections(p).ok).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("proxyBaseOf normalizes scheme and default ports", () => {
	expect(proxyBaseOf("http://hub.local:4101")).toBe("http://hub.local:4101");
	expect(proxyBaseOf("https://hub.local")).toBe("http://hub.local:443");
	expect(proxyBaseOf("http://hub.local")).toBe("http://hub.local:80");
});
