// desktop-live-acceptance.ts — W2869.3 live acceptance: a REAL Pi Durable
// model+tool run through the desktop hub buckle (:4111) with a freshly
// minted scoped key, ledger-correlated usage, and the revoke fence proven
// on the live wire (next served call after revoke = 401).
//
// Prereqs: desktop hub up (stack.json hubs.desktop), Docker running for
// the container leg, `bun run scripts/desktop-live-acceptance.ts` from
// packages/suspenders. Machine conf is read from its designated homes
// (stack.json → deploy dir → HUB_BUCKLE_ENV_FILE → BUCKLE_ROOT_KEY);
// values stay in process memory — nothing is printed. The minted key is
// revoked before exit; test keys are never left behind.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgD = join(import.meta.dir, "..");
const modUrl = (rel: string): string => `file://${pkgD}/${rel}`;

const stackPath = join(process.env.HOME ?? "", ".config/klh/stack.json");
const stack = JSON.parse(readFileSync(stackPath, "utf8")) as {
	hubs: Record<string, { deploy: { dir: string }; buckle_port: number }>;
};
const hubDir = stack.hubs.desktop.deploy.dir.replace(
	"~",
	process.env.HOME ?? "",
);
const composeEnv = readFileSync(join(hubDir, ".env"), "utf8");
const buckleEnvFile = composeEnv
	.split("\n")
	.find((l) => l.startsWith("HUB_BUCKLE_ENV_FILE="))
	?.slice(20)
	.trim()
	.replace("~", process.env.HOME ?? "");
const envFilePath = buckleEnvFile?.includes("/")
	? buckleEnvFile
	: join(hubDir, buckleEnvFile ?? "");
const adminKey = readFileSync(envFilePath, "utf8")
	.split("\n")
	.map((l) => l.trim())
	.find((l) => l.startsWith("BUCKLE_ROOT_KEY="))
	?.slice(16);
if (!adminKey) throw new Error("BUCKLE_ROOT_KEY absent from hub buckle env");
const candidates = [`http://127.0.0.1:${stack.hubs.desktop.buckle_port}`];
if (candidates.length === 0)
	throw new Error("no desktop candidates in hubs.json");
let hub = "";
let modelsList: string[] = [];
for (const c of candidates) {
	try {
		const res = await fetch(new URL("/v1/models", c), {
			headers: { authorization: `Bearer ${adminKey}` },
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) continue;
		const body = (await res.json()) as { data?: { id: string }[] };
		modelsList = (body.data ?? []).map((m) => m.id);
		hub = c;
		break;
	} catch {
		/* try the next candidate */
	}
}
if (!hub) throw new Error("no reachable desktop hub candidate");
console.log("hub reachable, models:", modelsList.length);
const run8 = crypto.randomUUID().slice(0, 8);
const mintRes = await fetch(new URL("/v1/admin/keys", hub), {
	method: "POST",
	headers: {
		authorization: `Bearer ${adminKey}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		name: `w28693-live-${run8}`,
		scopes: ["buckle:proxy:WRITE_"],
	}),
	signal: AbortSignal.timeout(5000),
});
if (!mintRes.ok)
	throw new Error(`mint failed: ${mintRes.status} ${await mintRes.text()}`);
const minted = (await mintRes.json()) as { key_id: string; key: string };
console.log("minted key_id:", minted.key_id);
const { createModels, createProvider } = await import("@earendil-works/pi-ai");
const openai = await import(
	`file://${join(pkgD, "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js")}`
);
const modelId =
	modelsList.find((m) => m.includes("glm")) ??
	(modelsList.includes("general") ? "general" : modelsList[0]);
const base = new URL("/v1", hub).toString().replace(/\/$/, "");
const provider = createProvider({
	id: "belt-live",
	baseUrl: base,
	auth: {
		apiKey: {
			name: "belt-live",
			resolve: async () => ({
				auth: { apiKey: minted.key },
				source: "w28693-live",
			}),
		},
	},
	models: [
		{
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: "belt-live",
			baseUrl: base,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 32_768,
			maxTokens: 2_048,
		},
	],
	api: {
		"openai-completions": {
			stream: openai.stream,
			streamSimple: openai.streamSimple,
		},
	},
});
const models = createModels();
models.setProvider(provider);
console.log("provider up, model:", modelId);
const { createDesktopRunnerLeaf } = await import(
	modUrl("hooks/lib/runners/desktop/wiring.ts")
);
const { RunnerSpecSchema } = await import(
	modUrl("hooks/lib/runners/control/control-state.ts")
);
const { canonicalSeedDigest, scanSeedDir } = await import(
	modUrl("hooks/lib/runners/desktop/seed.ts")
);
const { sqliteStore } = await import(
	modUrl("hooks/lib/runners/control/store.ts")
);
const { ensureRunnerLeaseSchema } = await import(
	modUrl("hooks/lib/runners/control/leases.ts")
);
const { ensureRunnerReaderSchema } = await import(
	modUrl("hooks/lib/runners/control/cursors.ts")
);
const { RUNNER_SCOPES } = await import(
	modUrl("hooks/lib/runners/control/rights.ts")
);
const { Database } = require("bun:sqlite");
const { createRegistry } = await import("@earendil-works/pi-durable");
const fs = await import("node:fs");
const os = await import("node:os");
const world = fs.mkdtempSync(join(os.tmpdir(), "w28693-live-"));
for (const d of ["state", "workspaces", "seed"])
	fs.mkdirSync(join(world, d), { recursive: true });
fs.writeFileSync(join(world, "seed/seed.md"), "live acceptance seed\n");
const store = sqliteStore(new Database(join(world, "governor.db")));
ensureRunnerLeaseSchema(store);
ensureRunnerReaderSchema(store);
const runId = crypto.randomUUID();
const leaf = createDesktopRunnerLeaf({
	store,
	durableRoot: join(world, "state"),
	runtime: {
		models,
		registry: createRegistry(),
		env: {},
		settings: undefined,
		onReport: () => {},
	},
	container: {
		image:
			"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
		workspacesDir: join(world, "workspaces"),
		seedRoot: join(world, "seed"),
	},
	credentials: {
		baseUrl: hub,
		adminKey,
		receiptsPath: join(world, "receipts.json"),
	},
	executorSid: "live-acceptance",
	leaseTtlMs: 6_000,
	cleanupTimeoutMs: 2_000,
});
const spec = RunnerSpecSchema.parse({
	version: 1 as const,
	runId,
	owner: "w2869.3-live",
	generation: 1,
	kind: "coding" as const,
	seedDigest: canonicalSeedDigest(await scanSeedDir(join(world, "seed"))),
	policyDigest: leaf.policyDigest(),
	provider: "belt-live",
	model: modelId,
});
const actor = {
	sid: "host-witness",
	scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
};
await leaf.admitAndStart({ spec, actor, seedRoot: join(world, "seed") });
console.log("admitted epoch-1");
await leaf.controller.submit({
	runId,
	text: "Reply with exactly the word ALIVE and nothing else.",
	actor,
});
console.log("submitted — waiting for a real assistant message");
let assistantText = "";
let usage: Record<string, unknown> | undefined;
const stateDir = join(world, "state", runId, "state");
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !assistantText) {
	await new Promise((r) => setTimeout(r, 500));
	for (const f of findJournal(stateDir)) {
		for (const line of readFileSync(f, "utf8").trim().split("\n")) {
			try {
				const e = JSON.parse(line) as {
					writes?: {
						type?: string;
						value?: {
							kind?: string;
							model?: {
								role?: string;
								content?: unknown;
								usage?: Record<string, unknown>;
							}[];
						};
					}[];
				};
				for (const w of e.writes ?? []) {
					if (w.type !== "entry" || w.value?.kind !== "pi.assistant") continue;
					for (const m of w.value.model ?? []) {
						if (m.role !== "assistant") continue;
						const c = m.content;
						assistantText =
							typeof c === "string"
								? c
								: Array.isArray(c)
									? c
											.filter((p) => p.type === "text")
											.map((p) => (p as { text?: string }).text)
											.join("")
									: "";
						usage = m.usage;
					}
				}
			} catch {
				/* partial line at the journal tail */
			}
		}
		if (assistantText) break;
	}
}
console.log("assistant said:", assistantText || "NOTHING");
if (usage)
	console.log(
		"journal usage row:",
		JSON.stringify({
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
		}),
	);
const toolOut = await leaf.executor.dispatchTool(
	runId,
	[
		"sh",
		"-c",
		"echo live-acceptance > /workspace/marker.txt; cat /workspace/marker.txt",
	],
	{ timeoutMs: 15_000 },
);
console.log("tool half ok:", toolOut.code === 0, toolOut.stdout.trim());
// ledger correlation: the hub's usage ledger must carry THIS key's request
const ledRes = await fetch(
	new URL(`/v1/admin/requests?limit=50&key=${minted.key_id}`, hub),
	{
		headers: { authorization: `Bearer ${adminKey}` },
		signal: AbortSignal.timeout(5000),
	},
);
const ledBody = (await ledRes.json()) as {
	requests?: {
		actor?: string;
		served_model?: string;
		in_tok?: number;
		out_tok?: number;
		cache_r?: number;
	}[];
};
const led = (ledBody.requests ?? []).filter((r) => r.actor === minted.key_id);
console.log(
	"ledger rows for key:",
	led.length,
	led.length
		? JSON.stringify(
				led.map((r) => ({
					served_model: r.served_model,
					in_tok: r.in_tok,
					out_tok: r.out_tok,
					cache_r: r.cache_r,
				})),
			)
		: "",
);
console.log(
	"PROBE_RESULT",
	JSON.stringify({
		assistant: assistantText.includes("ALIVE"),
		tool: toolOut.code === 0 && toolOut.stdout.includes("live-acceptance"),
		ledger: led.length > 0,
		key_id: minted.key_id,
	}),
);
// revoke fence on the LIVE hub: revoke the minted key, expect 401 on the
// very next served call with the same key material
const revRes = await fetch(
	new URL(`/v1/admin/keys/${minted.key_id}/revoke`, hub),
	{
		method: "POST",
		headers: { authorization: `Bearer ${adminKey}` },
		signal: AbortSignal.timeout(5000),
	},
);
console.log("revoke status:", revRes.status);
const served = await fetch(new URL("/v1/chat/completions", hub), {
	method: "POST",
	headers: {
		authorization: `Bearer ${minted.key}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		model: modelId,
		max_tokens: 4,
		messages: [{ role: "user", content: "hi" }],
	}),
	signal: AbortSignal.timeout(8000),
});
console.log(
	"served-after-revoke:",
	served.status,
	served.status === 401 ? "FENCED" : "NOT FENCED",
);
// revoke the leftover probe keys too (test keys are never left behind)
for (const staleId of ["a1859746c5a8", "6a3b322e790f", "b8dca8e4fdc3"]) {
	if (staleId === minted.key_id) continue;
	const r = await fetch(new URL(`/v1/admin/keys/${staleId}/revoke`, hub), {
		method: "POST",
		headers: { authorization: `Bearer ${adminKey}` },
		signal: AbortSignal.timeout(5000),
	});
	console.log("revoke leftover", staleId, r.status);
}
await leaf.close();
fs.rmSync(world, { recursive: true, force: true });
console.log("world cleaned");
await leaf.close();
function findJournal(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
		const p = join(dir, name);
		if (p.endsWith(".jsonl")) out.push(p);
	}
	return out;
}
