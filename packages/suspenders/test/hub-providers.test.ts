// test/hub-providers.test.ts — W1124.8.2.1: central provider profiles →
// hub delivery. The shared resolver (speedy/provider-config.ts, W1124.8.1)
// feeds requiredProviders → renderProviderEnv → hubctl push's 0600
// provider.env on the target. Secrets stay central: tests assert the env
// BINDING lands, never the raw key in any output surface.
import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROVIDER_ENV_FILENAME,
	centralProviderProfiles,
	providerIdentityByEnv,
	renderProviderEnv,
	requiredProviders,
	tryLoadProviderConfig,
} from "../hooks/lib/hub-providers.ts";
import { resolveProvider } from "../../speedy/src/provider-config.ts";

const PROVIDERS = {
	"zai-coding": {
		provider: "zai",
		key: "zk-live-0123456789abcdef", // scrub:allow
		env: "Z_AI_API_KEY",
		endpoints: { anthropic: "https://api.z.ai/api/anthropic" },
	},
};

const resolved = (): NonNullable<ReturnType<typeof resolveProvider>> =>
	resolveProvider("zai-coding", PROVIDERS) as NonNullable<
		ReturnType<typeof resolveProvider>
	>;

test("renderProviderEnv binds each profile's key to its declared env name", () => {
	expect(renderProviderEnv([resolved()])).toBe(
		"Z_AI_API_KEY=zk-live-0123456789abcdef\n", // scrub:allow
	);
	expect(renderProviderEnv([])).toBe("");
});

test("requiredProviders resolves declared profiles through the shared resolver", () => {
	const rows = requiredProviders(
		{ provider_requirements: ["zai-coding"] },
		PROVIDERS,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.name).toBe("zai-coding");
	expect(rows[0]?.env).toBe("Z_AI_API_KEY");
	expect(rows[0]?.endpoints.anthropic).toBe("https://api.z.ai/api/anthropic");
});

test("requiredProviders fails closed on an unknown or unbound profile — never the key", () => {
	expect(() =>
		requiredProviders({ provider_requirements: ["ghost"] }, PROVIDERS),
	).toThrow('provider profile "ghost"');
	expect(() =>
		requiredProviders(
			{ provider_requirements: ["keyless"] },
			{ keyless: { provider: "zai", key: "zk-x" } },
		),
	).toThrow("declares no env binding");
	for (const run of [
		() => requiredProviders({ provider_requirements: ["ghost"] }, PROVIDERS),
		() =>
			requiredProviders(
				{ provider_requirements: ["keyless"] },
				{ keyless: { provider: "zai", key: "zk-x" } },
			),
	]) {
		try {
			run();
		} catch (e) {
			expect(String(e)).not.toContain("zk-");
		}
	}
});

test("no requirements resolves to [] WITHOUT reading provider config", () => {
	const prev = process.env.KLH_STACK;
	process.env.KLH_STACK = join(tmpdir(), "hub-providers-missing-stack.yaml");
	try {
		expect(requiredProviders({})).toEqual([]);
		expect(requiredProviders({ provider_requirements: [] })).toEqual([]);
	} finally {
		if (prev === undefined) delete process.env.KLH_STACK;
		else process.env.KLH_STACK = prev;
	}
});

test("tryLoadProviderConfig degrades to null on missing, wrong-mode, or malformed stacks", () => {
	const dir = mkdtempSync(join(tmpdir(), "hub-providers-"));
	try {
		const good = join(dir, "good.json");
		writeFileSync(
			good,
			JSON.stringify({
				providers: {
					"zai-coding": {
						provider: "zai",
						key: "zk-live-0123456789abcdef", // scrub:allow
						env: "Z_AI_API_KEY",
					},
				},
			}),
			{ mode: 0o600 },
		);
		const lax = join(dir, "lax.json");
		writeFileSync(lax, `{"providers": {}}\n`);
		chmodSync(lax, 0o644);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, `{"providers": ["not", "a", "map"]}\n`, {
			mode: 0o600,
		});

		const prev = process.env.KLH_STACK;
		try {
			process.env.KLH_STACK = good;
			expect(Object.keys(tryLoadProviderConfig() ?? {})).toEqual([
				"zai-coding",
			]);
			process.env.KLH_STACK = lax;
			expect(tryLoadProviderConfig()).toBeNull(); // mode 600 enforced
			process.env.KLH_STACK = bad;
			expect(tryLoadProviderConfig()).toBeNull();
			process.env.KLH_STACK = join(dir, "absent.yaml");
			expect(tryLoadProviderConfig()).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.KLH_STACK;
			else process.env.KLH_STACK = prev;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("centralProviderProfiles exposes names/bindings/endpoints — never key material", () => {
	const rows = centralProviderProfiles(PROVIDERS);
	expect(rows).toEqual([
		{
			name: "zai-coding",
			provider: "zai",
			env: "Z_AI_API_KEY",
			endpoints: { anthropic: "https://api.z.ai/api/anthropic" },
		},
	]);
	expect(JSON.stringify(rows)).not.toContain("zk-live"); // scrub:allow
});

test("providerIdentityByEnv maps env bindings to non-secret identity — never keys", () => {
	const id = providerIdentityByEnv(
		{ provider_requirements: ["zai-coding"] },
		PROVIDERS,
	);
	expect(id).toEqual({
		Z_AI_API_KEY: { provider: "zai", providerProfile: "zai-coding" },
	});
	expect(JSON.stringify(id)).not.toContain("zk-"); // scrub:allow
	// soft: unknown, unbound, or absent config contribute no identity
	expect(
		providerIdentityByEnv({ provider_requirements: ["ghost"] }, PROVIDERS),
	).toEqual({});
	expect(
		providerIdentityByEnv(
			{ provider_requirements: ["keyless"] },
			{ keyless: { provider: "zai", key: "zk-x" } },
		),
	).toEqual({});
	expect(providerIdentityByEnv({})).toEqual({});
	expect(
		providerIdentityByEnv(
			{ provider_requirements: ["zai-coding"] },
			{} as never,
		),
	).toEqual({});
});

test("hubctl push materializes provider.env ON the target — 0600, env names, no key on stdout", () => {
	const dir = mkdtempSync(join(tmpdir(), "hub-providers-push-"));
	const deployDir = join(dir, "hub");
	const stackPath = join(dir, "stack.json");
	writeFileSync(
		stackPath,
		JSON.stringify({
			version: "v-w1124-8-2-1",
			hubs: {
				prov: {
					host: "127.0.0.1",
					buckle_port: 14401,
					provider_requirements: ["zai-coding"],
					deploy: { dir: deployDir },
				},
			},
			providers: {
				"zai-coding": {
					provider: "zai",
					key: "zk-live-0123456789abcdef", // scrub:allow
					env: "Z_AI_API_KEY",
					endpoints: { anthropic: "https://api.z.ai/api/anthropic" },
				},
			},
		}),
		{ mode: 0o600 },
	);
	try {
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"push",
				"prov",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, KLH_STACK: stackPath },
			},
		);
		const out = r.stdout.toString() + r.stderr.toString();
		expect(r.exitCode).toBe(0);
		const envPath = join(deployDir, PROVIDER_ENV_FILENAME);
		expect(readFileSync(envPath, "utf8")).toBe(
			"Z_AI_API_KEY=zk-live-0123456789abcdef\n", // scrub:allow
		);
		expect((statSync(envPath).mode & 0o777).toString(8)).toBe("600");
		// the raw key never prints — the log carries the BINDING name only
		expect(out).toContain("Z_AI_API_KEY");
		expect(out).not.toContain("zk-live"); // scrub:allow
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a hub with no provider_requirements still pushes — empty provider.env keeps env_file valid", () => {
	const dir = mkdtempSync(join(tmpdir(), "hub-providers-noreq-"));
	const deployDir = join(dir, "hub");
	const stackPath = join(dir, "stack.json");
	writeFileSync(
		stackPath,
		JSON.stringify({
			version: "v-w1124-8-2-1",
			hubs: {
				noreq: {
					host: "127.0.0.1",
					buckle_port: 14402,
					deploy: { dir: deployDir },
				},
			},
		}),
		{ mode: 0o600 },
	);
	try {
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"push",
				"noreq",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, KLH_STACK: stackPath },
			},
		);
		expect(r.exitCode).toBe(0);
		expect(readFileSync(join(deployDir, PROVIDER_ENV_FILENAME), "utf8")).toBe(
			"",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
