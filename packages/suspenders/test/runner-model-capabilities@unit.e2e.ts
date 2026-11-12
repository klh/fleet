import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld, serveStub, runCliAsync } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { discoverRunnerModels } from "../hooks/lib/runners/service/model-capabilities.ts";

const row = (id = "selected") => ({
	id,
	object: "model",
	owned_by: "buckle",
	context_length: 131072,
	max_output_tokens: 16384,
	reasoning: true,
	capability_source: "operator-pinned",
});
const profiles = { standard: { provider: "belt", model: "selected" } };
test("streamed catalog bytes and late headers or body are bounded and cancelled @unit", async () => {
	let oversizedCancelled = false;
	const oversized = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(65537));
		},
		cancel() {
			oversizedCancelled = true;
		},
	});
	await expect(
		discoverRunnerModels({
			baseUrl: "https://example.invalid",
			adminKey: "fixture-mint",
			profiles,
			fetch: async () => new Response(oversized),
		}),
	).rejects.toThrow("runner.model_catalog_unavailable");
	expect(oversizedCancelled).toBe(true);
	let lateBodyCancelled = false;
	const lateBody = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("{"));
		},
		cancel() {
			lateBodyCancelled = true;
		},
	});
	const started = performance.now();
	await Promise.all([
		expect(
			discoverRunnerModels({
				baseUrl: "https://example.invalid",
				adminKey: "fixture-mint",
				profiles,
				fetch: async () => new Response(lateBody),
			}),
		).rejects.toThrow("runner.model_catalog_unavailable"),
		expect(
			discoverRunnerModels({
				baseUrl: "https://example.invalid",
				adminKey: "fixture-mint",
				profiles,
				fetch: (_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error("fixture-mint transport failure")),
							{ once: true },
						);
					}),
			}),
		).rejects.toThrow("runner.model_catalog_unavailable"),
	]);
	expect(performance.now() - started).toBeLessThan(4500);
	expect(lateBodyCancelled).toBe(true);
});
test("a refused catalog cannot hang startup while cancelling its body @unit", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		cancel() {
			cancelled = true;
			return new Promise<void>(() => {});
		},
	});
	const result = await Promise.race([
		discoverRunnerModels({
			baseUrl: "https://example.invalid",
			adminKey: "fixture-mint",
			profiles,
			fetch: async () => new Response(body, { status: 403 }),
		}).then(
			() => "unexpected success",
			(error: unknown) =>
				error instanceof Error ? error.message : "unexpected error",
		),
		Bun.sleep(100).then(() => "cancellation blocked startup"),
	]);
	expect(result).toBe("runner.model_catalog_unauthorized");
	expect(cancelled).toBe(true);
});
test("HTTP, parser and transport diagnostics redact received secrets and cancel refused bodies @unit", async () => {
	for (const status of [401, 403, 500]) {
		let cancelled = false;
		const body = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			discoverRunnerModels({
				baseUrl: "https://example.invalid",
				adminKey: "fixture-mint",
				profiles,
				fetch: async () => new Response(body, { status }),
			}),
		).rejects.toThrow(
			status === 500
				? "runner.model_catalog_unavailable"
				: "runner.model_catalog_unauthorized",
		);
		expect(cancelled).toBe(true);
	}
	for (const fetchCatalog of [
		async () => {
			throw new Error("fixture-mint provider-secret");
		},
		async () => new Response("fixture-mint provider-secret"),
		async () =>
			Response.json({
				object: "list",
				data: [{ ...row(), context_length: "fixture-mint provider-secret" }],
			}),
	]) {
		try {
			await discoverRunnerModels({
				baseUrl: "https://example.invalid",
				adminKey: "fixture-mint",
				profiles,
				fetch: fetchCatalog,
			});
			throw new Error("unexpected success");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toMatch(/^Error: runner\.model_/);
			expect(String(error)).not.toContain("fixture-mint");
			expect(String(error)).not.toContain("provider-secret");
		}
	}
});
test("catalog endpoint and provider refusals happen before credentials leave the process @unit", async () => {
	let calls = 0;
	const fetchCatalog = async () => {
		calls++;
		return Response.json({ object: "list", data: [row()] });
	};
	for (const baseUrl of [
		"file:///private",
		"http://public.example",
		"https://fixture-mint@example.invalid",
		"https://user:fixture-mint@example.invalid",
		"bad-url",
	])
		await expect(
			discoverRunnerModels({
				baseUrl,
				adminKey: "fixture-mint",
				profiles,
				fetch: fetchCatalog,
			}),
		).rejects.toThrow("runner.invalid_model_catalog_endpoint");
	await expect(
		discoverRunnerModels({
			baseUrl: "https://example.invalid",
			adminKey: "fixture-mint",
			profiles: { standard: { provider: "other", model: "selected" } },
			fetch: fetchCatalog,
		}),
	).rejects.toThrow("runner.unsupported_provider");
	await expect(
		discoverRunnerModels({
			baseUrl: "https://example.invalid",
			adminKey: "fixture-mint",
			profiles: {},
			fetch: fetchCatalog,
		}),
	).rejects.toThrow("runner.model_profiles_required");
	expect(calls).toBe(0);
});

test("redirects never forward the mint credential to another origin @unit", async () => {
	const destination = serveStub(() =>
		Response.json({ object: "list", data: [row()] }),
	);
	const origin = serveStub(() =>
		Response.redirect(`${destination.url}/v1/models`, 307),
	);
	try {
		await expect(
			discoverRunnerModels({
				baseUrl: origin.url,
				adminKey: "fixture-mint",
				profiles,
			}),
		).rejects.toThrow("runner.model_catalog_unavailable");
		expect(origin.requests).toHaveLength(1);
		expect(destination.requests).toHaveLength(0);
	} finally {
		try {
			origin.close();
		} finally {
			destination.close();
		}
	}
});
test("only complete unambiguous selected rows can become runtime models @unit", async () => {
	const cases = [
		{ rows: [], error: "runner.model_not_advertised" },
		{ rows: [row(), row()], error: "runner.model_catalog_ambiguous" },
		...Object.keys(row())
			.filter((key) =>
				[
					"context_length",
					"max_output_tokens",
					"reasoning",
					"capability_source",
				].includes(key),
			)
			.map((key) => ({
				rows: [
					Object.fromEntries(
						Object.entries(row()).filter(([field]) => field !== key),
					),
				],
				error: "runner.model_capabilities_incomplete",
			})),
		...[
			{ context_length: 0 },
			{ context_length: -1 },
			{ max_output_tokens: "16384" },
			{ reasoning: "false" },
			{ capability_source: "guessed" },
		].map((patch) => ({
			rows: [{ ...row(), ...patch }],
			error: "runner.model_capabilities_incomplete",
		})),
	];
	for (const example of cases) {
		const stub = serveStub(() =>
			Response.json({ object: "list", data: example.rows }),
		);
		try {
			await expect(
				discoverRunnerModels({
					baseUrl: stub.url,
					adminKey: "fixture-mint",
					profiles,
				}),
			).rejects.toThrow(example.error);
		} finally {
			stub.close();
		}
	}
});

test("selected limits map exactly into the SDK and retain each advertised provenance @unit", async () => {
	const rows = [
		row(),
		{
			...row("other"),
			context_length: 9999999,
			max_output_tokens: 999999,
			reasoning: false,
			capability_source: "provider-published",
		},
		{ ...row("third"), capability_source: "locally-demonstrated" },
	];
	const stub = serveStub(() =>
		Response.json({
			object: "list",
			data: [
				...rows,
				{ id: "unselected", object: "model", owned_by: "buckle" },
			],
		}),
	);
	try {
		const catalog = await discoverRunnerModels({
			baseUrl: stub.url,
			adminKey: "fixture-mint",
			profiles: {
				...profiles,
				duplicate: profiles.standard,
				other: { provider: "belt", model: "other" },
				third: { provider: "belt", model: "third" },
			},
		});
		expect(catalog.capabilities).toEqual(rows);
		expect(catalog.models).toHaveLength(3);
		for (const [index, model] of catalog.models.entries())
			expect(model).toMatchObject({
				contextWindow: rows[index]?.context_length,
				maxTokens: rows[index]?.max_output_tokens,
				reasoning: rows[index]?.reasoning,
			});
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]).toMatchObject({
			path: "/v1/models",
			auth: "Bearer fixture-mint",
		});
		const { createModels, createProvider } = await import(
			"@earendil-works/pi-ai"
		);
		const { stream, streamSimple } = await import(
			"@earendil-works/pi-ai/api/openai-completions"
		);
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "belt",
				auth: {
					apiKey: {
						name: "belt",
						resolve: async () => ({
							auth: { apiKey: "fixture-leaf" },
							source: "runner",
						}),
					},
				},
				models: catalog.models,
				api: { "openai-completions": { stream, streamSimple } },
			}),
		);
		expect(models.getModel("belt", "other")).toMatchObject({
			contextWindow: 9999999,
			maxTokens: 999999,
			reasoning: false,
		});
	} finally {
		stub.close();
	}
});

for (const mode of [
	"runtime",
	"preflight",
	"preflight-complete",
	"preflight-forbidden",
])
	test(`production ${mode} respects selected model capability admission @unit`, async () => {
		const world = scratchWorld();
		const authority = serveStub((request) =>
			new URL(request.url).pathname === "/v1/fleet/whoami"
				? Response.json({
						authenticated: true,
						kind: "api_key",
						key_id: "fixture",
						team: null,
						actor: null,
						scopes:
							mode === "preflight-forbidden"
								? ["buckle:admin:WRITE_"]
								: ["buckle:admin:WRITE_", "buckle:proxy:READ_"],
					})
				: mode === "preflight-forbidden"
					? new Response("fixture-mint should not escape", { status: 403 })
					: Response.json({
							object: "list",
							data: [
								mode === "preflight-complete"
									? row()
									: { id: "selected", object: "model", owned_by: "buckle" },
							],
						}),
		);
		try {
			const bin = join(world.home, "bin"),
				seed = join(world.home, "seed"),
				state = join(world.home, "state");
			await mkdir(bin);
			await mkdir(seed, { mode: 0o700 });
			await writeFile(
				join(bin, "docker"),
				'#!/usr/bin/env bun\nif(process.argv.includes("image"))console.log("sha256:"+"a".repeat(64));else if(process.argv.includes("info"))console.log("[]");else process.exit(71);',
				{ mode: 0o700 },
			);
			await writeFile(join(world.home, "mint.key"), "fixture-mint", {
				mode: 0o600,
			});
			const profilesFile = join(world.home, "profiles.json");
			await writeFile(
				profilesFile,
				JSON.stringify({
					standard: {
						version: 1,
						generation: 1,
						kind: "coding",
						seedDigest: "a".repeat(64),
						policyDigest: "b".repeat(64),
						provider: "belt",
						model: "selected",
					},
				}),
				{ mode: 0o600 },
			);
			const moduleUrl = (path: string) =>
				new URL(`../hooks/lib/runners/service/${path}.ts`, import.meta.url)
					.href;
			const script = join(world.repo, "runtime.ts");
			await writeFile(
				script,
				`import {RunnerSettingsSchema} from ${JSON.stringify(import.meta.resolve("@klh/settings"))};\nimport {desktopRuntime} from ${JSON.stringify(moduleUrl("desktop-runtime"))};\nimport {openRunnerHost} from ${JSON.stringify(moduleUrl("host"))};\nimport {runnerHostConfig} from ${JSON.stringify(moduleUrl("config"))};\nconst config=RunnerSettingsSchema.parse(${JSON.stringify({ identity_url: authority.url, state_dir: state, profiles_file: profilesFile, credential_file: join(world.home, "control.key"), desktop: { image: `example/base@sha256:${"a".repeat(64)}`, seed_root: seed, mint_credential_file: join(world.home, "mint.key") } })});\nlet host;try{host=await openRunnerHost({...runnerHostConfig(config),port:0,...await desktopRuntime(config,${JSON.stringify(state)})});console.log(JSON.stringify({refused:false}));}catch(error){console.log(JSON.stringify({refused:true,error:error.message}));}finally{await host?.stop();}`,
			);
			const configFile = join(world.home, "settings.json");
			await writeFile(
				configFile,
				JSON.stringify({
					runner: {
						identity_url: authority.url,
						state_dir: state,
						profiles_file: profilesFile,
						credential_file: join(world.home, "control.key"),
						desktop: {
							image: `example/base@sha256:${"a".repeat(64)}`,
							seed_root: seed,
							mint_credential_file: join(world.home, "mint.key"),
						},
					},
				}),
				{ mode: 0o600 },
			);
			const cli = new URL("../hooks/bin/runner-control.ts", import.meta.url)
				.pathname;
			const result = await runCliAsync(
				mode.startsWith("preflight") ? cli : script,
				mode.startsWith("preflight") ? ["--check"] : [],
				{
					env: {
						...world.env,
						SUSPENDERS_KEV_URL: undefined,
						KLH_SETTINGS: configFile,
						PATH: `${bin}:${process.env.PATH}`,
					},
				},
			);
			if (mode === "preflight-complete") {
				expect(result.code, result.err).toBe(0);
				expect(JSON.parse(result.out)).toMatchObject({
					preflight: "passed",
					modelCapabilities: [row()],
				});
			} else if (mode.startsWith("preflight")) {
				const { stripVTControlCharacters } = await import("node:util");
				expect(result.code, result.out + result.err).toBe(1);
				expect(result.out).toBe("");
				expect(stripVTControlCharacters(result.err).trim()).toBe(
					mode === "preflight-forbidden"
						? "runner.model_catalog_unauthorized"
						: "runner.model_capabilities_incomplete",
				);
			} else {
				expect(result.code, result.err).toBe(0);
				expect(JSON.parse(result.out)).toEqual({
					refused: true,
					error: "runner.model_capabilities_incomplete",
				});
			}
			expect(
				authority.requests.some(
					(request) =>
						request.path.includes("/admin/keys") ||
						request.path.includes("/chat/completions"),
				),
			).toBe(false);
		} finally {
			try {
				authority.close();
			} finally {
				world.clean();
			}
		}
	});
