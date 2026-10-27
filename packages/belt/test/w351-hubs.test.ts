// W351 — remote buckle hubs as supervised probe-only rows: registry parsing,
// supervisor target shape, fleetTargets port dedupe, llms.txt row rendering.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "../../test-kit/src/index.ts";
import {
	browserConsoleUrl,
	configuredProviderIdentity,
	hubLlmsRows,
	hubRegistryRevision,
	hubTargets,
	readHubs,
} from "../bin/hubs.ts";
import { fleetTargets, isAlert } from "../bin/supervisor.ts";

const { home: dir, clean } = scratchWorld({ prefix: "w351-" });
afterAll(() => clean());

const REGISTRY = {
	NAS: { candidates: ["http://nas.example.lan:4101"] },
	DESKTOP: { candidates: ["https://desktop.example.lan"] },
};

test("catalog provider identity requires the effective configured candidate", () => {
	const openrouter = {
		url: "http://127.0.0.1:4100",
		dialect: "openai",
		adapter: "openai-compat",
		api_key_env: "LITELLM_KEY",
		model: "openrouter/vendor/model:free",
	};
	const generated = { "openrouter/vendor/model:free": [openrouter] };
	expect(
		configuredProviderIdentity(
			"openrouter/vendor/model:free",
			openrouter,
			generated,
		),
	).toEqual({ provider: "openrouter", id: "vendor/model:free" });
	expect(
		configuredProviderIdentity(
			"openrouter/vendor/model:free",
			{ ...openrouter, url: "http://elsewhere.example:4100" },
			generated,
		),
	).toBeNull();
	const zai = { ...openrouter, model: "zai-glm-5.3" };
	expect(
		configuredProviderIdentity("glm-5.3", zai, { "glm-5.3": [zai] }),
	).toEqual({
		provider: "zai",
		id: "glm-5.3",
	});
	expect(
		configuredProviderIdentity(
			"glm-5.3",
			{ ...zai, model: "other" },
			{ "glm-5.3": [zai] },
		),
	).toBeNull();
});

function regFile(body: unknown): string {
	const p = join(dir, `reg-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(p, JSON.stringify(body));
	return p;
}

describe("readHubs", () => {
	test("registry revision ignores partial JSON but notices a completed change", () => {
		const registry = join(dir, "watched-hubs.json");
		process.env.SUSPENDERS_HUBS_FILE = registry;
		try {
			expect(hubRegistryRevision()).toBe("");
			writeFileSync(registry, '{"NAS":');
			expect(hubRegistryRevision()).toBeNull();
			writeFileSync(registry, JSON.stringify(REGISTRY));
			expect(hubRegistryRevision()).toBe(JSON.stringify(REGISTRY));
		} finally {
			delete process.env.SUSPENDERS_HUBS_FILE;
		}
	});

	test("links require explicit safe URLs; remote .local is never guessed", () => {
		const rows = readHubs(
			regFile({
				NAS: {
					candidates: ["http://nas.example.lan:4101"],
					console_url: "https://nas.example.lan/",
				},
				LOCAL_ONLY: {
					candidates: ["http://host.example.lan:4101"],
					console_url: "https://host.local/",
				},
			}),
		);
		expect(rows[0]?.consoleUrl).toBe("https://nas.example.lan/");
		expect(rows[1]?.consoleUrl).toBeUndefined();
		expect(browserConsoleUrl("https://192.0.2.4:7799/")).toBe(
			"https://192.0.2.4:7799/",
		);
		expect(browserConsoleUrl("https://host.local/")).toBeNull();
		expect(browserConsoleUrl("https://host.local/", false)).toBe(
			"https://host.local/",
		);
		expect(browserConsoleUrl("javascript:alert(1)")).toBeNull();
		expect(browserConsoleUrl("https://user:secret@example.org/")).toBeNull();
	});
	test("missing file → no rows (belt runs hub-less)", () => {
		expect(readHubs(join(dir, "nope.json"))).toEqual([]);
	});

	test("parses http + https candidates to host/port/tls", () => {
		expect(readHubs(regFile(REGISTRY))).toEqual([
			{
				label: "NAS",
				base: "http://nas.example.lan:4101",
				host: "nas.example.lan",
				port: 4101,
				tls: false,
			},
			{
				label: "DESKTOP",
				base: "https://desktop.example.lan",
				host: "desktop.example.lan",
				port: 443,
				tls: true,
			},
		]);
	});

	test("skips junk entries (no candidates / bad URL / bad scheme)", () => {
		const rows = readHubs(
			regFile({
				EMPTY: {},
				NOURL: { candidates: ["not a url"] },
				FTP: { candidates: ["ftp://x"] },
				GOOD: { candidates: ["http://g.example.lan:2"] },
			}),
		);
		expect(rows.map((r) => r.label)).toEqual(["GOOD"]);
	});
});

describe("hubTargets", () => {
	test("probe-only rows with parsed host/port + scheme for TLS", () => {
		process.env.SUSPENDERS_HUBS_FILE = regFile(REGISTRY);
		// W371: pin the stack away so no real deploy profile joins the rows —
		// this test pins the PROBE-ONLY baseline shape.
		process.env.KLH_STACK = join(dir, "absent-stack.yaml");
		try {
			expect(hubTargets()).toEqual([
				{
					name: "NAS",
					port: 4101,
					kind: "hub",
					owned: false,
					host: "nas.example.lan",
					healthPath: "/api/health",
				},
				{
					name: "DESKTOP",
					port: 443,
					kind: "hub",
					owned: false,
					host: "desktop.example.lan",
					scheme: "https",
					healthPath: "/api/health",
				},
			]);
		} finally {
			delete process.env.SUSPENDERS_HUBS_FILE;
			delete process.env.KLH_STACK;
		}
	});

	test("an unowned hub never alerts — visibility, not alarms", () => {
		expect(isAlert("hub", false, "down")).toBe(false);
		expect(isAlert("hub", false, "up")).toBe(false);
	});
});

describe("fleetTargets", () => {
	test("resident Kev is checked through its served model endpoint", () => {
		const kev = fleetTargets().find((target) => target.port === 8912);
		expect(kev?.kind).toBe("external");
		expect(kev?.healthPath).toBe("/v1/models");
	});

	test("fleet rows keep unique ports with hubs folded in", () => {
		const ts = fleetTargets();
		const ports = ts.map((t) => t.port);
		expect(new Set(ports).size).toBe(ports.length);
		for (const hub of ts.filter((t) => t.kind === "hub")) {
			expect(hub.owned).toBe(false);
			expect(hub.host).toBeTruthy();
		}
	});
});

test("llms rows render label + base + state", () => {
	expect(hubLlmsRows(readHubs(regFile(REGISTRY)), () => "up")).toEqual([
		"- NAS http://nas.example.lan:4101 — up",
		"- DESKTOP https://desktop.example.lan — up",
	]);
});
