// test/install-openrouter-preflight.e2e.ts — W2546.2: the OpenRouter
// stale-snapshot preflight inside seedLocalLlm's gateway regen. The
// 2026-11-02 incident: regenGatewayConfig preflighted only Z.ai staleness,
// so a >2h openrouter-free.json (groups byte-identical to live) died inside
// openRouterFreeRows and exit-1'd the whole install. Every case here runs
// the REAL seedLocalLlm (belt closure heal + REAL generator spawn on the
// happy path) against a kit scratchWorld repo + an isolated flat home —
// no ambient machine state, fetchers injected, inference key owned by the
// fixture home's stack.json provider profile (W1124.8.4 contract — the
// implicit openrouter.key file read is retired).
// W2546.2.2 fixture lifecycle: every world registers at mint and cleans in
// afterEach even when setup or an assertion fails; the kit's env pins are
// APPLIED to process.env (not just returned) so in-process reads and every
// spawned helper see the isolated HOME/store/telemetry configuration.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchWorld, type ScratchWorld } from "@klh/test-kit";
import type { StepContext } from "../scripts/install/install-run.ts";
import { seedLocalLlm } from "../scripts/install/install-llm-steps.ts";

const REPO = join(import.meta.dir, ".."); // packages/suspenders

// Seed's spawned fixtures (router smoke) only bind when the flat home lives
// under a real-user $HOME — homes under /var/folders hang the bun runtime
// pre-bind (observed 2026-10-15, pinned in install-llm-steps.test.ts). The
// kit world stays the fixture base (env pins, repo, clean() teardown); only
// its mkdtemp parent moves under $HOME/.cache, like the legacy suite.
const CACHE_BASE = join(process.env.HOME ?? "", ".cache", "w25462-tests");

// Fixture-pinned knobs (test-kit's world.env carries the first three; the
// rest are the W2546.2.2 isolation seams): dead ports make every ambient
// store/telemetry leg fail fast and quietly instead of reaching the real
// control plane or hanging a request. Isolated git identity blocks config
// writes to the operator's real ~/.gitconfig.
const ENV_PINS: Record<string, string> = {
	GOVERNOR_STORE_URL: "local",
	// W1124.8.4: key resolution rides the central provider profile. The
	// "" apply is transient — worldFor immediately repins KLH_STACK at the
	// fixture home's stack.json; the entry exists so snapshot/restore
	// covers the key (bun's os.homedir() ignores process.env.HOME, so the
	// fixture HOME alone cannot redirect the default resolver).
	KLH_STACK: "",
	SUSPENDERS_KEV_URL: "http://127.0.0.1:9",
	SUSPENDERS_KNOWLEDGE_SINK_URL: "http://127.0.0.1:9",
	SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS: "50",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

type Snapshot = Record<string, string | undefined>;

const snapshotEnv = (keys: string[]): Snapshot => {
	const snap: Snapshot = {};
	for (const key of keys) snap[key] = process.env[key];
	return snap;
};

/** Exact restore: originally absent keys are deleted again (an empty-string
 *  restore would read as a SET knob), present ones get their value back. */
const restoreEnv = (snap: Snapshot): void => {
	for (const [key, value] of Object.entries(snap)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
};

const worlds: ScratchWorld[] = [];

/** Mint an isolated world, APPLY its env pins to this process (in-process
 *  reads and spawned helpers inherit them), and register it for guaranteed
 *  afterEach cleanup — a failed assertion or setup error never leaks the
 *  home/repo dirs again (the 2026-11-02 six-store-server incident). */
const worldFor = (label: string): ScratchWorld => {
	mkdirSync(CACHE_BASE, { recursive: true });
	const world = scratchWorld({ prefix: `${label}-`, dir: CACHE_BASE });
	worlds.push(world);
	// world.env (kit pins + HOME) first, then this suite's pins — never
	// return-only: seedLocalLlm's spawned helpers inherit process.env.
	for (const [key, value] of Object.entries(world.env))
		if (value !== undefined) process.env[key] = value;
	for (const [key, value] of Object.entries(ENV_PINS)) process.env[key] = value;
	// W1124.8.4: the default inference-key resolver walks KLH_STACK (the
	// fixture home's provider-profile stack), never an ambient machine one.
	process.env.KLH_STACK = join(world.home, ".config", "klh", "stack.json");
	return world;
};

const OPENROUTER_PUBLIC =
	"https://openrouter.ai/api/v1/models?output_modalities=all";
const OPENROUTER_ACCOUNT = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_ACCEPT = "openrouter-free-sync.ts sync --output";

const GROUPS = [
	"openrouter/free",
	"openrouter/google/gemma-4-31b-it:free",
	"openrouter/recursive/flint-v1.0:free",
];
// public ∩ account ids for GROUPS (id = group minus the openrouter/ prefix)
const FREE_IDS = [
	"openrouter/free",
	"google/gemma-4-31b-it:free",
	"recursive/flint-v1.0:free",
];

const STALE_YAML =
	"# GENERATED by belt gateway tooling (2020-01-01T00:00:00.000Z) — do not edit by hand.\nold: yaml\n";

/** A scratch HOME whose flat local-llm home carries a stale-or-fresh
 *  snapshot, an optional key, and a yaml the staleness guard must flag. */
const staleHome = (
	home: string,
	opts: { ageMs?: number; key?: boolean; groups?: string[] } = {},
) => {
	const { ageMs = 3 * 60 * 60 * 1000, key = true, groups = GROUPS } = opts;
	const llm = join(home, ".claude", "local-llm");
	mkdirSync(llm, { recursive: true });
	writeFileSync(join(llm, "litellm.yaml"), STALE_YAML);
	writeFileSync(join(llm, "remotes.json"), JSON.stringify({ machines: [] }));
	writeFileSync(join(llm, "belt.env"), "BELT_WIRED_GUARD_GB=73\n", {
		mode: 0o600,
	});
	const snapshot = join(llm, "openrouter-free.json");
	writeFileSync(snapshot, JSON.stringify(freeSnapshotDoc(groups, ageMs)), {
		mode: 0o600,
	});
	// W1124.8.4: the inference key rides a provider profile in the fixture
	// home's OWN stack.json (mode 600, KLH_STACK-pinned below) — the implicit
	// openrouter.key file read is retired.
	if (key) {
		const stackDir = join(home, ".config", "klh");
		mkdirSync(stackDir, { recursive: true });
		writeFileSync(
			join(stackDir, "stack.json"),
			JSON.stringify({
				providers: {
					"openrouter-inference": {
						provider: "openrouter",
						key: "fixture-secret",
						env: "OPENROUTER_API_KEY",
					},
				},
			}),
			{ mode: 0o600 },
		);
	}
	return {
		llm,
		snapshot,
		stackPath: join(home, ".config", "klh", "stack.json"),
	};
};

const freeSnapshotDoc = (groups: string[], ageMs: number): unknown => ({
	version: 1,
	source: OPENROUTER_PUBLIC,
	account_source: OPENROUTER_ACCOUNT,
	generated_at: new Date(Date.now() - ageMs).toISOString(),
	public_model_count: 685,
	account_model_count: 407,
	groups: Object.fromEntries(groups.map((g) => [g, [routeFor(g)]])),
	excluded_free_models: [],
});

const routeFor = (group: string) => ({
	url: "http://127.0.0.1:4100",
	dialect: "openai",
	adapter: "openai-compat",
	api_key_env: "LITELLM_KEY",
	adapter_config: { proxy_kind: "litellm" },
	model: group,
});

const catalogPage = (ids: string[]): unknown => ({
	data: ids.map((id) => ({
		id,
		pricing: { prompt: "0", completion: "0" },
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
	})),
});

/** fetcher serving the public and account catalogs for exactly `ids`. */
const serving = (ids: string[], calls: string[] = []) =>
	(async (url: string | URL | Request) => {
		calls.push(String(url));
		return Response.json(catalogPage(ids));
	}) as typeof fetch;

/** Records generator spawns without running them (blocked-path scenarios). */
const recorder = () => {
	const runs: string[][] = [];
	return {
		runs,
		run: async (argv: string[]) => {
			runs.push(argv);
		},
	};
};

/** seedLocalLlm ctx bound to the real checkout; the kit home supplies the
 *  flat home and the npm symlink target (the package's own node_modules,
 *  standing in for an installed prefix — W778 shape). */
function ctxFor(llmHome: string): StepContext {
	// W778: the flat home resolves npm deps through a node_modules symlink to
	// the prefix's — a real install always has one. The kit imports real
	// packages (zod via stack-config.ts), so the fixture rides the checkout's
	// own node_modules rather than a stub.
	const prefix = join(llmHome, "prefix-unused");
	if (!existsSync(join(prefix, "node_modules"))) {
		mkdirSync(prefix, { recursive: true });
		// the package's own node_modules (isolated linker: the repo root
		// carries only the test runner) mirrors the installed prefix's
		symlinkSync(join(REPO, "node_modules"), join(prefix, "node_modules"));
	}
	return {
		repo: REPO,
		prefix,
		shimBin: join(llmHome, "bin-unused"),
		llmHome,
		home: join(llmHome, "..", ".."),
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
		wireRepo: null,
	};
}

test.describe("@unit install OpenRouter stale-snapshot preflight", () => {
	// W2546.2.2: snapshot exactly what worldFor pins — the kit world.env
	// writes back process.env unchanged except its four pins (HOME, the two
	// GIT_CONFIG_* files, GOVERNOR_STORE_URL), all covered by HOME ∪ ENV_PINS.
	// Restore BEFORE the world teardown (restore-precedes-rmSync) and clean
	// EVERY registered world even when an assertion or setup threw mid-test —
	// clean()-after-assertions leaked homes on every failure (46 dirs
	// survived the 2026-11-02 broken runs).
	const envSnapshot = snapshotEnv(["HOME", ...Object.keys(ENV_PINS)]);
	test.afterEach(() => {
		try {
			restoreEnv(envSnapshot);
		} finally {
			for (const world of worlds.splice(0)) world.clean();
		}
	});

	test("stale timestamp, groups unchanged: snapshot refreshed, REAL regen green", async () => {
		const world = worldFor("w25462-heal");
		const { llm, snapshot } = staleHome(world.home);
		const calls: string[] = [];
		const res = await seedLocalLlm(ctxFor(llm), {
			openRouterFetcher: serving(FREE_IDS, calls),
		});
		expect(res.status).toBe("ok");
		expect(res.note).toContain("OpenRouter free catalog snapshot refreshed");
		expect(calls).toEqual([OPENROUTER_PUBLIC, OPENROUTER_ACCOUNT]);
		const doc = JSON.parse(readFileSync(snapshot, "utf8"));
		expect(Date.now() - Date.parse(doc.generated_at)).toBeLessThan(120_000);
		expect(Object.keys(doc.groups).sort()).toEqual([...GROUPS].sort());
		expect(readFileSync(snapshot, "utf8")).not.toContain("fixture-secret");
		const yamlText = readFileSync(join(llm, "litellm.yaml"), "utf8");
		expect(yamlText).toContain('model_name: "openrouter/free"');
		expect(yamlText).not.toContain("old: yaml");
	});

	test("route objects with REORDERED properties stay valid (#102805 control)", async () => {
		const world = worldFor("w25462-order");
		const { llm, snapshot } = staleHome(world.home);
		// reverse each route object's property order — byte-equivalent JSON
		const doc = JSON.parse(readFileSync(snapshot, "utf8")) as {
			groups: Record<string, Array<Record<string, unknown>>>;
		};
		const reordered = Object.fromEntries(
			Object.entries(doc.groups).map(([g, routes]) => [
				g,
				routes.map((r) => Object.fromEntries(Object.entries(r).reverse())),
			]),
		);
		writeFileSync(snapshot, JSON.stringify({ ...doc, groups: reordered }), {
			mode: 0o600,
		});
		const res = await seedLocalLlm(ctxFor(llm), {
			openRouterFetcher: serving(FREE_IDS),
		});
		expect(res.status).toBe("ok");
		expect(res.note).toContain("OpenRouter free catalog snapshot refreshed");
	});

	test("route with a CHANGED value or an ADDED field is invalid (#102805 control)", async () => {
		const world = worldFor("w25462-value");
		for (const [label, mutate, invalidMsg] of [
			[
				"url",
				(r: Record<string, unknown>) => {
					r.url = "http://127.0.0.1:9999";
				},
				"invalid OpenRouter free catalog route",
			],
			[
				"added",
				(r: Record<string, unknown>) => {
					r.extra = "x";
				},
				"invalid OpenRouter free catalog snapshot",
			],
		] as const) {
			const { llm, snapshot } = staleHome(world.home, { key: false });
			const doc = JSON.parse(readFileSync(snapshot, "utf8"));
			mutate(doc.groups["openrouter/free"][0]);
			writeFileSync(snapshot, JSON.stringify(doc), { mode: 0o600 });
			const before = readFileSync(snapshot, "utf8");
			const { runs, run } = recorder();
			const res = await seedLocalLlm(ctxFor(llm), {
				openRouterFetcher: serving(FREE_IDS),
				openRouterKey: () => "fixture-secret",
				run,
			});
			expect(res.status, label).toBe("failed");
			// url drift fails route equality; an added field fails the strict
			// shape schema first — both bounded, both name the sync command
			expect(res.note, label).toContain(invalidMsg);
			expect(res.note).toContain(OPENROUTER_ACCEPT);
			expect(readFileSync(snapshot, "utf8")).toBe(before);
			expect(runs).toEqual([]);
		}
	});

	test("real route-set delta: fails naming the delta, snapshot + yaml untouched, no regen", async () => {
		const world = worldFor("w25462-delta");
		const { llm, snapshot } = staleHome(world.home);
		const before = readFileSync(snapshot, "utf8");
		const { runs, run } = recorder();
		// live drops flint, adds gemma-26b — public ∩ account changes
		const liveIds = [
			"openrouter/free",
			"google/gemma-4-31b-it:free",
			"google/gemma-4-26b-a4b-it:free",
		];
		const res = await seedLocalLlm(ctxFor(llm), {
			openRouterFetcher: serving(liveIds),
			run,
		});
		expect(res.status).toBe("failed");
		expect(res.note).toContain("gateway config regen FAILED");
		expect(res.note).toContain("+openrouter/google/gemma-4-26b-a4b-it:free");
		expect(res.note).toContain("-openrouter/recursive/flint-v1.0:free");
		expect(res.note).toContain(OPENROUTER_ACCEPT);
		expect(readFileSync(snapshot, "utf8")).toBe(before);
		expect(readFileSync(join(llm, "litellm.yaml"), "utf8")).toContain(
			"old: yaml",
		);
		expect(runs).toEqual([]);
	});

	test("unverifiable live catalog (HTTP 401; missing key file, zero fetches): bounded failure, preserved", async () => {
		const world = worldFor("w25462-unver");
		for (const [key, cause, fetches] of [
			[true, "HTTP 401", 2],
			[false, "ENOENT", 0],
		] as const) {
			// iteration 1 writes the key file; the missing-key case must not
			// inherit it (same flat home across iterations)
			if (!key)
				rmSync(join(world.home, ".config/klh/stack.json"), { force: true });
			const { llm, snapshot } = staleHome(world.home, { key });
			const before = readFileSync(snapshot, "utf8");
			const calls: string[] = [];
			const fetcher = (async (url: string | URL | Request) => {
				calls.push(String(url));
				return new Response("denied", { status: 401 });
			}) as typeof fetch;
			const { runs, run } = recorder();
			const res = await seedLocalLlm(ctxFor(llm), {
				openRouterFetcher: fetcher,
				// key resolution pinned to the fixture — never the ambient machine
				openRouterKey:
					key === false
						? () => {
								throw new Error("ENOENT: no provider profile bound");
							}
						: () => "fixture-secret",
				run,
			});
			expect(res.status).toBe("failed");
			expect(res.note).toContain("could not be revalidated");
			expect(res.note).toContain(cause);
			expect(res.note).toContain(OPENROUTER_ACCEPT);
			expect(calls).toHaveLength(fetches);
			expect(readFileSync(snapshot, "utf8")).toBe(before);
			expect(runs).toEqual([]);
		}
	});

	test("malformed snapshot, arrays-as-groups, null, bad timestamp: invalid, preserved", async () => {
		const world = worldFor("w25462-malformed");
		const variants: Array<[string, string]> = [
			["malformed", '{"version": 1, "groups": {"g": []}}'],
			["array-groups", JSON.stringify({ version: 1, groups: [] })],
			["null-doc", "null"],
		];
		for (const [label, raw] of variants) {
			const { llm, snapshot } = staleHome(world.home);
			writeFileSync(snapshot, raw, { mode: 0o600 });
			const { runs, run } = recorder();
			const res = await seedLocalLlm(ctxFor(llm), {
				openRouterFetcher: serving(FREE_IDS),
				run,
			});
			expect(res.status, label).toBe("failed");
			expect(res.note).toContain("invalid OpenRouter free catalog snapshot");
			expect(res.note).toContain(OPENROUTER_ACCEPT);
			expect(readFileSync(snapshot, "utf8")).toBe(raw);
			expect(runs).toEqual([]);
		}
	});

	test("fresh snapshot or none at all: zero fetches, no key read, regen proceeds", async () => {
		const world = worldFor("w25462-fresh");
		// fresh: no fetch, the REAL generator spawns and stays green
		const fresh = staleHome(world.home, { ageMs: 60_000 });
		const calls: string[] = [];
		const { runs, run } = recorder();
		const res = await seedLocalLlm(ctxFor(fresh.llm), {
			openRouterFetcher: serving(FREE_IDS, calls),
			openRouterKey: () => {
				throw new Error("key must not be read for a fresh snapshot");
			},
			run,
		});
		expect(res.status).toBe("ok");
		expect(res.note).not.toContain("OpenRouter free catalog snapshot");
		expect(calls).toEqual([]);
		expect(runs).toHaveLength(1);
		// absent: same no-op (no snapshot file, no key profile, no fetch)
		rmSync(join(fresh.llm, "openrouter-free.json"));
		rmSync(join(world.home, ".config/klh/stack.json"), { force: true });
		const absentCalls: string[] = [];
		const res2 = await seedLocalLlm(ctxFor(fresh.llm), {
			openRouterFetcher: serving(FREE_IDS, absentCalls),
			run,
		});
		expect(res2.status).toBe("ok");
		expect(absentCalls).toEqual([]);
	});
});
