// W289 — registry one-source completion: `direct:` is emitted-only
// (parseDirect reads the emitted object shape), every registry row carries
// the operational fields (healthPath / launchdLabel / logPath), and
// /registry.json is served from the belt dashboard too (the router shim is
// the process most likely to be dark when the inventory is needed).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EMITTERS, registryEtag, registryJson } from "../bin/registry-emit.ts";
import {
	ROUTER,
	registryEntries,
	SWARM_AGENT,
	SWARM_LOG,
} from "../bin/registry.ts";
import {
	directTiersFromRegistry,
	loadDirectTiers,
	parseDirect,
	parseDirectTiersArtifact,
} from "../bin/router-policy.ts";
import { probePathFor } from "../bin/inventory-probe.ts";

describe("direct tiers are emitted-only (W289)", () => {
	test("parseDirect reads the emitted object shape", () => {
		const parsed = parseDirect(EMITTERS.direct());
		expect(Object.keys(parsed)).toEqual(registryEntries().map((e) => e.alias));
		expect(parsed["local-coder"]).toBe("http://127.0.0.1:8901/v1");
	});

	test("parseDirectTiersArtifact: rows pass, /v1 normalized (W726)", () => {
		expect(
			parseDirectTiersArtifact(
				JSON.stringify({
					"local-extract": "http://127.0.0.1:8902",
					"local-reason": "http://localhost:8903/v1/",
				}),
			),
		).toEqual({
			"local-extract": "http://127.0.0.1:8902/v1",
			"local-reason": "http://localhost:8903/v1",
		});
	});

	test("parseDirectTiersArtifact: bad row fails alone; empty/corrupt → null", () => {
		expect(
			parseDirectTiersArtifact(
				'{"a": "https://evil.example", "b": "http://127.0.0.1:8902"}',
			),
		).toEqual({ b: "http://127.0.0.1:8902/v1" });
		expect(parseDirectTiersArtifact("{}")).toBeNull();
		expect(parseDirectTiersArtifact("not json")).toBeNull();
		expect(parseDirectTiersArtifact("[]")).toBeNull();
	});

	test("legacy string rows still parse", () => {
		expect(parseDirect("direct:\n  x: http://localhost:8902\n")).toEqual({
			x: "http://localhost:8902/v1",
		});
	});

	test("non-loopback url throws in both shapes", () => {
		expect(() =>
			parseDirect("direct:\n  x: https://evil.example/v1\n"),
		).toThrow(/loopback/);
		expect(() =>
			parseDirect("direct:\n  x:\n    url: https://evil.example/v1\n"),
		).toThrow(/loopback/);
	});

	test("registry fallback = the hot chat classes only", () => {
		expect(directTiersFromRegistry()).toEqual({
			"local-coder": "http://127.0.0.1:8901/v1",
			"local-extract": "http://127.0.0.1:8902/v1",
			"local-reason": "http://127.0.0.1:8903/v1",
		});
	});
});

describe("loadDirectTiers chain (W289)", () => {
	test("nothing on disk → registry fallback", () => {
		const home = mkdtempSync(join(tmpdir(), "w289-home-"));
		try {
			expect(loadDirectTiers(undefined, home)).toEqual(
				directTiersFromRegistry(),
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("runtime YAML rows (legacy shape) still win", () => {
		const home = mkdtempSync(join(tmpdir(), "w289-home-"));
		try {
			mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
			writeFileSync(
				join(home, ".claude/local-llm/routing-policy.yaml"),
				"direct:\n  legacy: http://127.0.0.1:8902\n",
			);
			expect(loadDirectTiers(undefined, home)).toEqual({
				legacy: "http://127.0.0.1:8902/v1",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("runtime JSON direct rows win over legacy YAML", () => {
		const home = mkdtempSync(join(tmpdir(), "w975-direct-home-"));
		try {
			const runtime = join(home, ".claude/local-llm");
			mkdirSync(runtime, { recursive: true });
			writeFileSync(
				join(runtime, "routing-policy.yaml"),
				"direct:\n  legacy: http://127.0.0.1:8902\n",
			);
			writeFileSync(
				join(runtime, "routing-policy.json"),
				JSON.stringify({ direct: { current: "http://127.0.0.1:8903" } }),
			);
			expect(loadDirectTiers(undefined, home)).toEqual({
				current: "http://127.0.0.1:8903/v1",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the emitted direct-tiers.json artifact wins over the registry", () => {
		const home = mkdtempSync(join(tmpdir(), "w289-home-"));
		try {
			mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
			writeFileSync(
				join(home, ".claude/local-llm/direct-tiers.json"),
				'{"pinned-artifact": "http://127.0.0.1:8903/v1"}\n',
			);
			expect(loadDirectTiers(undefined, home)).toEqual({
				"pinned-artifact": "http://127.0.0.1:8903/v1",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("registry operational fields (W289)", () => {
	test("specialists carry health/label/log; externals carry what they have", () => {
		for (const s of registryEntries().filter((e) => !e.external)) {
			expect(s.healthPath).toBe("/v1/models");
			expect(s.launchdLabel).toBe("com.suspenders.local-llm");
			expect(s.logPath).toBe(SWARM_LOG);
		}
		const kev = registryEntries().find((e) => e.port === 8912);
		expect(kev?.healthPath).toBe("/v1/models");
		expect(kev?.launchdLabel).toBe("com.belt.kev");
		const emb = registryEntries().find((e) => e.port === 8907);
		expect(emb?.launchdLabel).toBe(SWARM_AGENT);
		expect(ROUTER.healthPath).toBe("/health/liveness");
		expect(ROUTER.launchdLabel).toBe("com.suspenders.local-llm");
	});

	test("probePathFor rides healthPath", () => {
		expect(probePathFor({})).toBe("/v1/models");
		expect(probePathFor({ healthPath: "/health" })).toBe("/health");
	});
});

describe("dashboard serves /registry.json (W289)", () => {
	const withDashboard = async (check: (base: string) => Promise<void>) => {
		const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
		const port = reservation.port;
		reservation.stop(true);
		const home = mkdtempSync(join(tmpdir(), "w289-dash-"));
		const proc = Bun.spawn(
			[process.execPath, resolve(import.meta.dir, "../bin/dashboard.ts")],
			{
				env: { ...process.env, HOME: home, BELT_PORT: String(port) },
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		const base = `http://127.0.0.1:${port}`;
		try {
			let ready = false;
			for (let i = 0; i < 100 && !ready; i++) {
				ready = await fetch(`${base}/health`)
					.then((r) => r.ok)
					.catch(() => false);
				if (!ready) await Bun.sleep(20);
			}
			if (!ready) throw new Error("dashboard did not start");
			await check(base);
		} finally {
			proc.kill();
			await proc.exited;
			rmSync(home, { recursive: true, force: true });
		}
	};

	test("GET → registry body + ETag; conditional GET → 304", async () => {
		await withDashboard(async (base) => {
			const r = await fetch(`${base}/registry.json`);
			expect(r.status).toBe(200);
			expect(await r.text()).toBe(registryJson());
			const etag = r.headers.get("etag") ?? "";
			expect(etag).toBe(registryEtag(registryJson()));
			const again = await fetch(`${base}/registry.json`, {
				headers: { "if-none-match": etag },
			});
			expect(again.status).toBe(304);
		});
	});
});
