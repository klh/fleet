// test/w1124-14-keepwarm-gate.test.ts — W1124.14: the cloud prefix warm +
// cache drill in llm-keepwarm.ts are operator opt-in, default OFF. The
// disabled branch must make ZERO inference calls — not even front contact —
// never touch the captured prefix file, and re-arm on the explicit knob.
// Every completion leg (prefix, cache, fallback) is opt-in; GET/local
// liveness probing stays default-on.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cacheDrillEnabled,
	fallbackDrillEnabled,
	optInEnabled,
	prefixWarmEnabled,
	warmTargets,
} from "../hooks/lib/keepwarm-gate.ts";

const COUNTER = new URL("./w1124-14-fetch-counter.ts", import.meta.url)
	.pathname;

describe("keepwarm cloud-drill opt-in knobs (W1124.14)", () => {
	test("only explicit truthy values enable; absent/empty/junk stay off", () => {
		expect(optInEnabled(undefined)).toBe(false);
		expect(optInEnabled("")).toBe(false);
		expect(optInEnabled(" ")).toBe(false);
		expect(optInEnabled("0")).toBe(false);
		expect(optInEnabled("false")).toBe(false);
		expect(optInEnabled("1")).toBe(true);
		expect(optInEnabled("true")).toBe(true);
		expect(optInEnabled("YES")).toBe(true);
		expect(optInEnabled("on")).toBe(true);
	});

	test("predicates default OFF; each knob arms only its own drill", () => {
		expect(prefixWarmEnabled({})).toBe(false);
		expect(cacheDrillEnabled({})).toBe(false);
		expect(fallbackDrillEnabled({})).toBe(false);
		expect(prefixWarmEnabled({ BELT_PREFIX_KEEPWARM_ENABLED: "1" })).toBe(true);
		expect(cacheDrillEnabled({ BELT_CACHE_DRILL_ENABLED: "1" })).toBe(true);
		expect(fallbackDrillEnabled({ BELT_FALLBACK_DRILL_ENABLED: "1" })).toBe(
			true,
		);
		expect(prefixWarmEnabled({ BELT_CACHE_DRILL_ENABLED: "1" })).toBe(false);
		expect(cacheDrillEnabled({ BELT_PREFIX_KEEPWARM_ENABLED: "1" })).toBe(
			false,
		);
		expect(fallbackDrillEnabled({ BELT_CACHE_DRILL_ENABLED: "1" })).toBe(false);
	});
});

describe("spawned keepwarm pass (W1124.14)", () => {
	/** Fixture: dead-port tier manifest (local liveness, no inference),
	 *  captured prefix file, front pinned to a dead loopback port. */
	const fixture = (dir: string) => {
		mkdirSync(join(dir, ".claude", "local-llm"), { recursive: true });
		const manifest = join(dir, "tier.json");
		const catalog = join(dir, ".claude", "local-llm", "direct-tiers.json");
		// dead-port tier manifest + matching catalog row: the warm set is
		// manifest ∩ catalog; the warm dials SUSPENDERS_BUCKLE_URL — unset
		// here, so the warm fails closed (the direct-wire bypass retired)
		writeFileSync(
			manifest,
			JSON.stringify({ tier: "minimal", warm_ports: [1] }),
		);
		writeFileSync(
			catalog,
			JSON.stringify({ "local-extract": "http://127.0.0.1:1/v1" }),
		);
		const prefixPath = join(dir, "prefix-cache.json");
		const captured = JSON.stringify({
			capturedAt: 1,
			model: "test-model",
			tools: [],
			system: "s",
		});
		writeFileSync(prefixPath, captured);
		return { manifest, prefixPath, captured };
	};
	/** Dead loopback pins: front :2, z.ai GET probe :3, gateway :4 — nothing
	 *  listens, every attempt fails fast, the counter sees them all. */
	const FRONT = "http://127.0.0.1:2";
	const ZAI = "http://127.0.0.1:3";
	const GATEWAY = "http://127.0.0.1:4";
	/** One pass through the fetch counter. Synthetic VALID keys ride along so
	 *  the drill paths WOULD fire if a gate leaked (the review-correction
	 *  case); the per-origin attempt cells prove they did not. */
	const runPass = (dir: string, knobs: Record<string, string>) => {
		const { manifest, prefixPath } = fixture(dir);
		const run = Bun.spawnSync(["bun", COUNTER], {
			env: {
				...process.env,
				HOME: dir,
				BELT_TIER_MANIFEST: manifest,
				SUSPENDERS_BUCKLE_FRONT: FRONT,
				BELT_ZAI_BASE: ZAI,
				BELT_GATEWAY_URL: GATEWAY,
				PREFIX_CACHE_PATH: prefixPath,
				BUCKLE_ADMIN_KEY: "bksk-test-synthetic",
				LITELLM_KEY: "lit-synthetic-test-key",
				...knobs,
			},
		});
		const out = run.stdout.toString();
		const cell = (origin: string): number => {
			const last = out.trimEnd().split("\n").at(-1) ?? "";
			const found = last.split(" ").find((c) => c.startsWith(`${origin}=`));
			return Number(found?.slice(origin.length + 1) ?? 0);
		};
		return { code: run.exitCode, out, cell };
	};
	test("disabled run: zero model calls despite valid keys, prefix file untouched", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1124-14-kw-"));
		const { prefixPath, captured } = fixture(dir);
		const { code, out, cell } = runPass(dir, {
			BELT_PREFIX_KEEPWARM_ENABLED: "",
			BELT_CACHE_DRILL_ENABLED: "",
			BELT_FALLBACK_DRILL_ENABLED: "",
		});
		expect(code).toBe(0);
		expect(out).toContain("disabled (opt-in BELT_PREFIX_KEEPWARM_ENABLED)");
		expect(out).toContain("disabled (opt-in BELT_CACHE_DRILL_ENABLED)");
		// the fallback line shows the GET-only posture, not a completion
		expect(out).toContain("GET probe; completion drill is opt-in");
		// cloud-drill zero-inference contract, per origin: no front contact (no
		// auth mint, no drill) and nothing dials the legacy gateway leg
		expect(cell(FRONT)).toBe(0);
		expect(cell(GATEWAY)).toBe(0);
		// GET/network liveness preserved: exactly the z.ai reachability GET
		expect(cell(ZAI)).toBe(1);
		// no forced deletes — the captured prefix survives verbatim
		expect(readFileSync(prefixPath, "utf8")).toBe(captured);
		// local liveness stays default-on: the gated warm fired at the unset
		// gate route and painted the honest down line (manifest ∩ catalog
		// = the one dead fixture alias; the direct-wire bypass is gone)
		expect(out).toContain("✗ :1 local-extract down");
	}, 20_000);

	test("opt-in re-arms all three drills (dead pins: attempts, never completions)", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1124-14-kw-"));
		const { code, out, cell } = runPass(dir, {
			BELT_PREFIX_KEEPWARM_ENABLED: "1",
			BELT_CACHE_DRILL_ENABLED: "1",
			BELT_FALLBACK_DRILL_ENABLED: "1",
		});
		expect(code).toBe(0);
		// every gate flipped: front auth probes fire (dead front pin →
		// unreachable), the fallback drill fails closed on the MISSING gate
		// route — before any z.ai probe — and nothing dials the legacy
		// gateway leg (the :4100 bypass retired)
		expect(cell(FRONT)).toBeGreaterThanOrEqual(2);
		expect(cell(GATEWAY)).toBe(0);
		expect(cell(ZAI)).toBe(0);
		expect(out).toContain(`buckle front ${FRONT} unreachable`);
		expect(out).toContain("buckle route missing");
		// auth never enrolled → warmOnce/drillCacheShare never ran
		expect(out).not.toContain("prefix replayed");
		expect(out).not.toContain("disabled (opt-in");
	}, 20_000);
});

describe("warmTargets (W1119.2 gated warm set)", () => {
	const tier = (warm_ports: unknown) => ({ warm_ports });
	const catalog = {
		"local-coder": "http://127.0.0.1:8901/v1",
		"local-extract": "http://127.0.0.1:8902/v1",
		"local-reason": "http://127.0.0.1:8903/v1",
	};

	test("warm_ports ∩ catalog aliases, port resolved from base URL", () => {
		const t = warmTargets(
			tier([8902, 8913]),
			catalog as Record<string, unknown>,
		);
		expect(t).toEqual([{ port: 8902, alias: "local-extract" }]);
	});

	test("ports with no catalog alias drop; empty warm set drops all", () => {
		expect(warmTargets(tier([8901, 8999]), catalog)).toEqual([
			{ port: 8901, alias: "local-coder" },
		]);
		expect(warmTargets(tier([]), catalog)).toEqual([]);
	});

	test("invalid warm_ports rows reject the whole set (fail-safe: warm nothing)", () => {
		expect(warmTargets(tier([8902, "8903"]), catalog)).toEqual([]);
		expect(warmTargets(tier([8902, -1]), catalog)).toEqual([]);
		expect(warmTargets(tier("nope"), catalog)).toEqual([]);
		expect(warmTargets({}, catalog)).toEqual([]);
	});

	test("malformed catalog rows are skipped, not fatal", () => {
		const t = warmTargets(tier([8902, 8903]), {
			"local-extract": "http://127.0.0.1:8902/v1",
			broken: "not a url",
			"no-port": "http://127.0.0.1/v1",
			123: 42,
		} as unknown as Record<string, unknown>);
		expect(t).toEqual([{ port: 8902, alias: "local-extract" }]);
	});
});
