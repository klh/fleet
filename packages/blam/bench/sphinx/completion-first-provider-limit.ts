import { createSandbox } from "./replay-sandbox";
import { traceModelFetch } from "./replay-wire";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import {
	BACKGROUND_CONTEXT as ctx,
	withAbortSignal,
} from "@earendil-works/chord/context";
import {
	adminKey,
	revokeLaneKey,
} from "@klh/suspenders/hooks/lib/lanes/lane-auth.ts";
import {
	IssueKeyResponseSchema,
	KeyListResponseSchema,
	ModelListResponseSchema,
} from "@klh/buckle/src/wire-schemas.ts";
import { realpath, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const front = "http://127.0.0.1:4101",
	model = "zai-glm-5.3-flash";
const maxTokensField = "max_tokens";
const suppliedWorkspace = process.argv[2];
if (!suppliedWorkspace?.startsWith("/"))
	throw Error("An absolute workspace is required");
const workspace = await realpath(suppliedWorkspace);
if (!(await lstat(`${workspace}/.git`)).isDirectory())
	throw Error("Expected a standalone clone with a real .git directory");
if (
	!workspace?.startsWith("/") ||
	workspace.includes(",") ||
	!(await Bun.file(`${workspace}/.git/config`).exists())
)
	throw Error("Expected an absolute disposable clone without commas");
const exportArg = process.argv[6];
const patchDestination = exportArg
	? join(await realpath(dirname(exportArg)), basename(exportArg))
	: null;
if (
	patchDestination &&
	(patchDestination === workspace ||
		patchDestination.startsWith(`${workspace}/`))
)
	throw Error("Patch destination must be outside the workspace");
const admin = adminKey();
if (!admin) throw Error("Audit authority unavailable");
const arm = process.argv[5];
if (arm !== "serial" && arm !== "parallel" && arm !== "smoke")
	throw Error("Expected serial, parallel or smoke");
const thinkingLevel = process.env.BLAM_PI_THINKING ?? "low";
if (
	thinkingLevel !== "off" &&
	thinkingLevel !== "low" &&
	thinkingLevel !== "medium"
)
	throw Error("BLAM_PI_THINKING must be off, low or medium");
const brief = arm === "smoke" ? "" : await Bun.file(process.argv[3]).text();
const pretask = arm === "smoke" ? "" : await Bun.file(process.argv[4]).text();
console.log(
	JSON.stringify({
		event: "pair-settings",
		arm,
		thinkingLevel,
		briefSha256: Bun.CryptoHasher.hash("sha256", brief, "hex"),
		pretaskSha256: Bun.CryptoHasher.hash("sha256", pretask, "hex"),
		contextWindow: 65536,
		maxTokens: 32768,
		reserveTokens: 16384,
		maxTokensField,
		wireOutputCap: null,
		maxTurns: null,
	}),
);
const lane = `w2960-pi-${crypto.randomUUID()}`;
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(Error("Replay interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
console.log(JSON.stringify({ event: "replay-identity", lane }));
const mint = await fetch(`${front}/v1/admin/keys`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${admin}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		name: lane,
		scopes: ["buckle:proxy:READ_", "buckle:proxy:WRITE_"],
		expires_in_s: 1500,
	}),
	signal: AbortSignal.timeout(5000),
});
if (!mint.ok) throw Error(`Mint HTTP ${mint.status}`);
const issued = await mint
	.json()
	.then((value) => IssueKeyResponseSchema.parse(value))
	.catch(async () => {
		const response = await fetch(`${front}/v1/admin/keys`, {
			headers: { authorization: `Bearer ${admin}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw Error("Invalid mint reply and key lookup failed");
		const key = KeyListResponseSchema.parse(await response.json()).keys.find(
			(row) => row.name === lane,
		);
		if (key)
			console.log(
				"scoped key revoked",
				await revokeLaneKey(key.key_id, admin, fetch, front),
			);
		throw Error("Invalid mint reply");
	});
let harness: Harness | undefined;
const started = performance.now();
const readLane = `${lane}-read`;
const originalFetch = globalThis.fetch;
globalThis.fetch = traceModelFetch(originalFetch, front, model, started);

let toolCalls = 0,
	firstSuccessfulCommandMs: number | null = null;
const { boot, guest, remove } = createSandbox(workspace, cancellation.signal);

try {
	const boots = await Promise.all([boot(lane, false), boot(readLane, true)]);
	if (boots.some((result) => result.exit !== 0))
		throw Error("Sandbox boot failed");
	const discovery = await fetch(`${front}/v1/models`, {
		headers: { authorization: `Bearer ${issued.key}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!discovery.ok) throw Error(`Catalog HTTP ${discovery.status}`);
	const catalog = ModelListResponseSchema.parse(await discovery.json());
	const advertised = catalog.data?.find(
		(row: { id: string }) => row.id === model,
	);
	if (!advertised) throw Error("Pinned model unavailable in scoped catalog");
	console.log(
		JSON.stringify({
			catalogCount: catalog.data.length,
			selected: advertised.id,
		}),
	);
	if (arm === "smoke") {
		const boundary = await guest(
			lane,
			"test $(id -u) = 1000 && ! touch .git/blocked",
			128,
			5,
		);
		const clipping = await guest(readLane, "head -c 20000 /dev/zero", 128, 5);
		const timeout = await guest(readLane, "sleep 5", 128, 1);
		if (
			boundary.exit !== 0 ||
			clipping.stdout.bytes !== 20000 ||
			clipping.stdout.text.length !== 128 ||
			!clipping.stdout.truncated ||
			!timeout.timedOut
		)
			throw Error("Sandbox smoke failed");
		console.log(
			JSON.stringify({
				event: "sandbox-smoke",
				readOnlyGit: true,
				outputClipped: true,
				timeoutReported: true,
			}),
		);
	} else {
		const models = createModels(),
			provider = "buckle-test";
		models.setProvider(
			createProvider({
				id: provider,
				baseUrl: `${front}/v1`,
				auth: {
					apiKey: {
						name: "Scoped test",
						resolve: async () => ({ auth: { apiKey: issued.key } }),
					},
				},
				models: [
					{
						id: model,
						name: model,
						provider,
						api: "openai-completions",
						baseUrl: `${front}/v1`,
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 65536,
						maxTokens: 32768,
						compat: {
							maxTokensField,
							thinkingFormat: "zai",
							supportsReasoningEffort: true,
						},
					},
				],
				api: openAICompletionsApi(),
			}),
		);
		let sawEdit = false;
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "sandbox",
				tools: [
					defineTool({
						name: "terminal",
						description:
							"Run one shell command inside the isolated repository at /workspace.",
						parameters: {
							type: "object",
							properties: { command: { type: "string", maxLength: 10000 } },
							required: ["command"],
							additionalProperties: false,
						},
						replay: "unsafe",
						async execute(raw) {
							toolCalls++;
							const toolStarted = performance.now();
							console.log(
								JSON.stringify({
									event: "tool-start",
									toolCalls,
									elapsedMs: Math.round(toolStarted - started),
								}),
							);
							if (typeof raw.command !== "string" || raw.command.length > 10000)
								throw Error("Invalid or excessive tool request");
							const out = await guest(lane, raw.command, 24000, 45);
							console.log(
								JSON.stringify({
									event: "tool-end",
									toolCalls,
									command: raw.command.slice(0, 2000),
									exit: out.exit,
									timedOut: out.timedOut,
									ms: Math.round(performance.now() - toolStarted),
									outBytes: out.stdout.bytes,
									errBytes: out.stderr.bytes,
								}),
							);
							if (out.exit === 0 && firstSuccessfulCommandMs === null)
								firstSuccessfulCommandMs = performance.now() - started;
							if (
								!sawEdit &&
								(
									await guest(
										readLane,
										"git -c core.fsmonitor=false diff --quiet --no-ext-diff --no-textconv HEAD -- sphinx/",
										1024,
										10,
									)
								).exit === 1
							) {
								sawEdit = true;
								console.log(
									JSON.stringify({
										event: "first-source-edit",
										elapsedMs: Math.round(performance.now() - started),
									}),
								);
							}
							return {
								output: [
									{
										type: "text",
										text: JSON.stringify({
											exit: out.exit,
											timedOut: out.timedOut,
											stdout: out.stdout,
											stderr: out.stderr,
										}),
									},
								],
							};
						},
					}),
				],
			}),
		);
		registry.install(
			defineExtension({
				name: "batched-inspection",
				tools: [
					defineTool({
						name: "inspect_batch",
						description:
							"Run up to four independent read-only shell inspections. Each result is clipped. Use terminal for edits.",
						parameters: {
							type: "object",
							properties: {
								commands: {
									type: "array",
									minItems: 1,
									maxItems: 4,
									items: { type: "string", maxLength: 2000 },
								},
							},
							required: ["commands"],
							additionalProperties: false,
						},
						replay: "safe",
						async execute(raw) {
							if (
								!Array.isArray(raw.commands) ||
								raw.commands.length > 4 ||
								raw.commands.length === 0 ||
								raw.commands.some(
									(x) => typeof x !== "string" || x.length > 2000,
								)
							)
								throw Error("Invalid inspection batch");
							const inspect = async (command: string) => {
								const id = ++toolCalls,
									at = performance.now();
								const result = await guest(readLane, command, 3500, 20);
								if (result.exit === 0 && firstSuccessfulCommandMs === null)
									firstSuccessfulCommandMs = performance.now() - started;
								console.log(
									JSON.stringify({
										event: "tool-end",
										toolCalls: id,
										mode: "batched-read",
										command,
										exit: result.exit,
										timedOut: result.timedOut,
										ms: Math.round(performance.now() - at),
										outBytes: result.stdout.bytes,
										errBytes: result.stderr.bytes,
									}),
								);
								return result;
							};
							const results = [];
							if (arm === "parallel")
								results.push(...(await Promise.all(raw.commands.map(inspect))));
							else
								for (const command of raw.commands)
									results.push(await inspect(command));
							return {
								output: [{ type: "text", text: JSON.stringify(results) }],
							};
						},
					}),
				],
			}),
		);
		harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				onReport: (report) => {
					const event = report as { type?: string; kind?: string };
					console.log(
						JSON.stringify({
							event: "sdk-report",
							type: event.type ?? event.kind ?? null,
							fields: Object.keys(event),
							elapsedMs: Math.round(performance.now() - started),
						}),
					);
				},
				settings: {
					toolExecution: "sequential",
					retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
					compaction: {
						enabled: true,
						reserveTokens: 16384,
						keepRecentTokens: 8000,
						backgroundTokens: 0,
					},
				},
			},
			ctx,
		);
		const conversation = await harness.root(ctx, {
			agent: {
				model: { provider, modelId: model },
				maxTurns: null,
				thinkingLevel,
			},
		});
		const submission = await conversation.submit(
			{
				type: "input",
				requestId: lane,
				content:
					"Fix this Sphinx issue in the repository. Identify the likely failing code path with a few targeted reads, then make the smallest source edit you can test. Use the verified offline test environment. Preserve public behavior. If a targeted test fails, use its output to refine the patch. " +
					brief +
					"\n\n" +
					pretask,
			},
			ctx,
		);
		try {
			const result = await submission.wait(
				withAbortSignal(
					AbortSignal.any([cancellation.signal, AbortSignal.timeout(1200000)]),
					ctx,
				),
			);
			console.log(
				JSON.stringify({
					elapsedMs: Math.round(performance.now() - started),
					firstSuccessfulCommandMs,
					toolCalls,
					status: result.status,
					usage: (await harness.usage(ctx)).models,
				}),
			);
			if (patchDestination) {
				const patch = await guest(
					readLane,
					"git -c core.fsmonitor=false diff --binary --no-ext-diff --no-textconv HEAD -- sphinx/",
					1048576,
					20,
				);
				if (patch.exit !== 0 || patch.stdout.truncated)
					throw Error("Could not export a complete sandbox diff");
				if (patch.stdout.text)
					await writeFile(patchDestination, patch.stdout.text, {
						flag: "wx",
						mode: 0o600,
					});
			}
		} catch (error) {
			try {
				await submission.abort(ctx);
			} catch {
				console.error("Submission abort failed");
			}
			console.log(
				JSON.stringify({
					event: "stopped",
					elapsedMs: Math.round(performance.now() - started),
					toolCalls,
					firstSuccessfulCommandMs,
					reason: error instanceof Error ? error.name : "unknown",
					usage: (await harness.usage(ctx)).models,
				}),
			);
			throw error;
		}
	}
} finally {
	try {
		await harness?.close(withAbortSignal(AbortSignal.timeout(10000), ctx));
	} finally {
		const cleanup = await Promise.allSettled([
			remove(lane, readLane),
			revokeLaneKey(issued.key_id, admin, originalFetch, front),
		]);
		const revoked = cleanup[1].status === "fulfilled" && cleanup[1].value;
		console.log("scoped key revoked", revoked);
		if (
			!revoked ||
			cleanup[0].status !== "fulfilled" ||
			cleanup[0].value.exit !== 0
		)
			process.exitCode = 1;
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
}
