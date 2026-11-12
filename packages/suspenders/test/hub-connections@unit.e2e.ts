import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { resetSettingsCache } from "@klh/settings";
import { loadStack } from "../hooks/lib/stack-config.ts";

test("actual upstream renderer refuses canonical profile and credential disagreement", async () => {
	const { renderUpstreams } = await import("../deploy/hubctl.ts");
	const { HubProfileSchema } = await import("../hooks/lib/stack-config.ts");
	const { validateProviderConfig, resolveProvider } = await import(
		"@klh/settings/connections"
	);
	const profiles = validateProviderConfig(
		Object.fromEntries(
			["one", "two"].map((name) => [
				name,
				{
					kind: "provider",
					provider: "fixture",
					adapter: "openai-compat",
					endpoints: { openai: `https://${name}.example/v1` },
					env: `${name.toUpperCase()}_OUTPUT`,
				},
			]),
		),
	);
	const required = ["one", "two"].map((name) => {
		const profile = resolveProvider(name, profiles);
		if (!profile) throw Error("Fixture profile absent");
		return profile;
	});
	const hub = (providerProfile?: string) =>
		HubProfileSchema.parse({
			host: "fixture.example",
			upstreams: {
				groups: {
					selected: [
						{
							dialect: "openai",
							api_key_env: "TWO_OUTPUT",
							...(providerProfile ? { providerProfile } : {}),
						},
					],
				},
			},
		});
	for (const rows of [
		required,
		...["one", "two"].map((legacyName) =>
			required.map((profile) =>
				profile.name === legacyName
					? { ...profile, connection: undefined }
					: profile,
			),
		),
	])
		expect(() => renderUpstreams(hub("one"), rows)).toThrow("disagree");
	for (const profile of [undefined, "two"]) {
		const row = JSON.parse(renderUpstreams(hub(profile), required)).groups
			.selected[0];
		expect(row).toMatchObject({
			providerProfile: "two",
			url: "https://two.example/v1",
		});
	}
	const legacy = required.map(
		({ connection: _connection, ...profile }) => profile,
	);
	expect(
		JSON.parse(renderUpstreams(hub("one"), legacy)).groups.selected[0]
			.providerProfile,
	).toBe("two");
});

test("actual isolated hubctl push wires canonical policy, routes and private env together", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	const world = scratchWorld(),
		root = join(import.meta.dir, "../../..");
	try {
		const doc = JSON.parse(
			readFileSync(join(root, "settings.template.json"), "utf8"),
		);
		const target = join(world.home, "generated"),
			settings = join(world.home, "settings.json");
		doc.version = "2.2.0";
		doc.hubs = {
			fixture: {
				host: "127.0.0.1",
				deploy: { dir: target },
				provider_requirements: ["example-account", "example-peer"],
				upstreams: {
					groups: {
						selected: [
							{
								providerProfile: "example-account",
								url: "https://unused.example",
								dialect: "openai",
							},
						],
						peer: [
							{
								providerProfile: "example-peer",
								url: "https://unused.example",
								dialect: "openai",
								adapter_config: { provider_pool: "foreign" },
							},
						],
					},
				},
			},
		};
		writeFileSync(settings, JSON.stringify(doc), { mode: 0o600 });
		const run = Bun.spawnSync(
			[
				process.execPath,
				join(root, "packages/suspenders/deploy/hubctl.ts"),
				"push",
				"fixture",
			],
			{
				env: {
					...world.env,
					KLH_SETTINGS: settings,
					KLH_STACK: join(world.home, "absent-stack.json"),
				},
				timeout: 10000,
				killSignal: "SIGKILL",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const routes = JSON.parse(
			readFileSync(join(target, "upstreams.hub.json"), "utf8"),
		);
		expect(routes.groups.selected[0]).toMatchObject({
			model: "operator-selected-model",
			adapter_config: { provider_pool: "example-subscription" },
			api_key_env: "EXAMPLE_PROVIDER_API_KEY",
		});
		expect(routes.groups.peer[0]).toMatchObject({
			buckle: true,
			connection_limit: 4,
			adapter_config: {},
		});
		const policy = JSON.parse(
			readFileSync(join(target, "routing-policy.hub.json"), "utf8"),
		);
		expect(policy.gateway.provider_pools["example-subscription"]).toMatchObject(
			{ concurrency: 2, maxOutstanding: 6 },
		);
		const env = join(target, "provider.env");
		expect(readFileSync(env, "utf8")).toBe(
			"EXAMPLE_PROVIDER_API_KEY=REPLACE_LOCALLY_WITH_PRIVATE_PROVIDER_KEY\n",
		);
		expect(statSync(env).mode & 0o777).toBe(0o600);
		expect(run.stdout.toString()).not.toContain(
			"REPLACE_LOCALLY_WITH_PRIVATE_PROVIDER_KEY",
		);
	} finally {
		world.clean();
	}
});

test("hub render settings diagnostics redact private keys", async () => {
	const { hubSettingsText } = await import("../deploy/hub-settings-render.ts");
	const world = scratchWorld(),
		previous = process.env.KLH_SETTINGS;
	try {
		const file = join(world.home, "settings.json");
		process.env.KLH_SETTINGS = file;
		writeFileSync(
			file,
			JSON.stringify({
				hubs: { fixture: {} },
				providers: {
					peer: {
						kind: "buckle",
						adapter: "buckle",
						endpoints: { openai: "http://peer.example/v1" },
						auth: { kind: "inline", key: "private-render-sentinel" },
					},
				},
			}),
			{ mode: 0o600 },
		);
		expect(hubSettingsText("fixture")).not.toContain("private-render-sentinel");
		expect(hubSettingsText("fixture")).toContain("<redacted>");
	} finally {
		if (previous === undefined) delete process.env.KLH_SETTINGS;
		else process.env.KLH_SETTINGS = previous;
		resetSettingsCache();
		world.clean();
	}
});

test("packed Speedy resolves canonical settings through its declared installed dependency", async () => {
	const { mkdirSync } = await import("node:fs");
	const world = scratchWorld(),
		root = join(import.meta.dir, "../../..");
	try {
		const packs = join(world.home, "packs"),
			app = join(world.home, "consumer");
		mkdirSync(packs);
		mkdirSync(app);
		const overrides: Record<string, string> = {};
		for (const name of ["kernel", "settings", "speedy"]) {
			const packed = Bun.spawnSync(
				[process.execPath, "pm", "pack", "--destination", packs],
				{
					cwd: join(root, "packages", name),
					timeout: 10000,
					killSignal: "SIGKILL",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(packed.exitCode).toBe(0);
			overrides[`@klh/${name}`] = join(packs, `klh-${name}-2.2.0.tgz`);
		}
		writeFileSync(
			join(app, "package.json"),
			JSON.stringify({
				private: true,
				dependencies: { "@klh/speedy": overrides["@klh/speedy"] },
				overrides,
			}),
		);
		const installed = Bun.spawnSync(
			[process.execPath, "install", "--offline", "--ignore-scripts"],
			{
				cwd: app,
				timeout: 15000,
				killSignal: "SIGKILL",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(installed.exitCode).toBe(0);
		const settings = join(app, "private.json");
		writeFileSync(
			settings,
			JSON.stringify({
				providers: {
					peer: {
						kind: "buckle",
						adapter: "buckle",
						endpoints: { openai: "http://peer.example/v1" },
					},
				},
			}),
			{ mode: 0o600 },
		);
		const checked = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				'import {loadProviderConfig} from "@klh/speedy/src/provider-config.ts";const p=loadProviderConfig();process.stdout.write(String(p.peer.provider==="buckle"&&p.peer.key===undefined))',
			],
			{
				cwd: app,
				env: { ...world.env, KLH_SETTINGS: settings },
				timeout: 5000,
				killSignal: "SIGKILL",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(checked.exitCode).toBe(0);
		expect(checked.stdout.toString()).toBe("true");
	} finally {
		world.clean();
	}
});

test("canonical projection enforces local models, account policy and peer separation", async () => {
	const { validateProviderConfig, resolveProvider } = await import(
		"@klh/settings/connections"
	);
	const { projectConnectionGroups, projectConnectionPolicy } = await import(
		"../deploy/hub-connections.ts"
	);
	const profiles = validateProviderConfig({
		account: {
			kind: "provider",
			provider: "example",
			adapter: "openai-compat",
			endpoints: { openai: "https://api.example/v1" },
			auth: { kind: "inline", key: "fixture-only" },
			env: "PROVIDER_OUTPUT",
			default_model: "selected",
			allowed_models: ["selected"],
			account: {
				id: "subscription",
				concurrency: 2,
				queue_limit: 3,
				pacing: {
					intervalCap: 4,
					intervalMs: 1000,
					queueWaitMs: 5000,
					recovery: { successWindow: 5, decreasePercent: 50 },
				},
			},
		},
		peer: {
			kind: "buckle",
			adapter: "buckle",
			endpoints: { openai: "http://peer.example/v1" },
			transport: { max_connections: 9 },
			discovery: { enabled: false },
		},
	});
	const required = Object.keys(profiles).map((name) => {
		const profile = resolveProvider(name, profiles);
		if (!profile) throw Error("Fixture profile absent");
		return profile;
	});
	const groups = projectConnectionGroups(
		{
			alias: [
				{ dialect: "openai", providerProfile: "account" },
				{ dialect: "openai", providerProfile: "account", model: "forbidden" },
				{
					dialect: "openai",
					providerProfile: "peer",
					api_key_env: "FOREIGN",
					adapter_config: { provider_pool: "foreign-account" },
				},
			],
		},
		required,
	);
	expect(groups.alias).toHaveLength(2);
	expect(groups.alias?.[0]).toMatchObject({
		model: "selected",
		url: "https://api.example/v1",
		api_key_env: "PROVIDER_OUTPUT",
		adapter_config: { provider_pool: "subscription" },
	});
	expect(groups.alias?.[1]).toMatchObject({
		buckle: true,
		connection_limit: 9,
		discover: false,
		adapter_config: {},
	});
	expect(groups.alias?.[1]).not.toHaveProperty("api_key_env");
	expect(projectConnectionPolicy(undefined, required)?.provider_pools).toEqual({
		subscription: {
			concurrency: 2,
			maxOutstanding: 5,
			intervalCap: 4,
			intervalMs: 1000,
			queueWaitMs: 5000,
			recovery: { successWindow: 5, decreasePercent: 50 },
		},
	});
	const account = required.find((profile) => profile.name === "account");
	if (account?.connection?.kind !== "provider")
		throw Error("Account fixture absent");
	const accountConnection = account.connection;
	const foreign = {
		...account,
		provider: "other",
		connection: { ...accountConnection, provider: "other" },
	};
	expect(() => projectConnectionPolicy(undefined, [account, foreign])).toThrow(
		"Conflicting policy",
	);
	expect(() =>
		projectConnectionPolicy(undefined, [
			{
				...account,
				connection: {
					...accountConnection,
					account: { id: "incomplete", concurrency: 2 },
				},
			},
		]),
	).toThrow();
	expect(() =>
		projectConnectionGroups(
			{
				alias: [
					{
						dialect: "openai",
						providerProfile: "peer",
						api_key_env: "PROVIDER_OUTPUT",
					},
				],
			},
			required,
		),
	).toThrow("disagree");
});

test("canonical settings wins over legacy pin and malformed canonical never borrows legacy", () => {
	const world = scratchWorld();
	const previous = {
		KLH_SETTINGS: process.env.KLH_SETTINGS,
		KLH_STACK: process.env.KLH_STACK,
	};
	try {
		const settings = join(world.home, "settings.json"),
			legacy = join(world.home, "stack.json");
		process.env.KLH_SETTINGS = settings;
		process.env.KLH_STACK = legacy;
		writeFileSync(legacy, JSON.stringify({ version: "legacy", hubs: {} }), {
			mode: 0o600,
		});
		writeFileSync(settings, JSON.stringify({ version: "canonical" }), {
			mode: 0o600,
		});
		resetSettingsCache();
		expect(loadStack().version).toBe("canonical");
		writeFileSync(settings, "{broken canonical");
		resetSettingsCache();
		expect(() => loadStack()).toThrow();
	} finally {
		for (const [name, value] of Object.entries(previous))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		resetSettingsCache();
		world.clean();
	}
});
