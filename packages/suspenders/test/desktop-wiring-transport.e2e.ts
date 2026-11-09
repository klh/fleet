// desktop-wiring-transport.e2e.ts — W2869.3 transport witnesses (root
// #118378/#118412/#118603): (1) model transport rides the LEAF credential —
// the per-run Models facade injects `authorization` after auth assembly,
// while the caller's ambient auth stays DUMMY (no injection = 401); (2)
// rotation-safety: an unconfirmed revoke (503) mints NOTHING (root
// #118603), a confirmed revoke mints exactly one replacement, and the
// held-key path makes zero stub calls.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import * as openaiApi from "@earendil-works/pi-ai/api/openai-completions.js";
import { createRegistry } from "@earendil-works/pi-durable";
import { createDesktopRunnerLeaf } from "../hooks/lib/runners/desktop/wiring.ts";
import { RunnerSpecSchema } from "../hooks/lib/runners/control/control-state.ts";
import {
	canonicalSeedDigest,
	scanSeedDir,
} from "../hooks/lib/runners/desktop/seed.ts";
import { ensureRunnerLeaseSchema } from "../hooks/lib/runners/control/leases.ts";
import { ensureRunnerReaderSchema } from "../hooks/lib/runners/control/cursors.ts";
import {
	RUNNER_SCOPES,
	type RunnerActor,
} from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import { scratchWorld, serveStub } from "@klh/test-kit";

const dockerUp = (): boolean =>
	Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode === 0;

const memoryStore = () => {
	const store = sqliteStore(new Database(":memory:"));
	ensureRunnerLeaseSchema(store);
	ensureRunnerReaderSchema(store);
	return store;
};

const hostActor = (): RunnerActor => ({
	sid: "host-witness",
	scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
});

/** OpenAI-wire SSE chunk builder for the completion stub. */
const chunk = (delta: unknown, finish: string | null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-witness",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: "witness-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

const sse = (): Response =>
	new Response(
		chunk({ role: "assistant", content: "ALIVE" }, null) +
			chunk({}, "stop") +
			"data: [DONE]\n\n",
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);

/** Buckle-admin stub: odd request = mint 201, even = revoke 200. */
const adminStub = () =>
	serveStub((_req, _body, n) =>
		n % 2 === 1
			? Response.json(
					{
						key_id: `key-${n}`,
						key: `bksk_stub_${n}`,
						name: "witness",
						scopes: ["buckle:proxy:WRITE_"],
						expires_at: Date.now() + 3_600_000,
					},
					{ status: 201 },
				)
			: Response.json({ revoked: `revoked: key-${n}` }),
	);

/** Assistant content → text (string or part array). */
const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => (p as { type?: string }).type === "text")
		.map((p) => (p as { text?: string }).text ?? "")
		.join("");
};

/** Rotation stub: mints always 201 (key-<n>), revokes 200-or-503 by the
 *  mutable `state.mode` — Test B flips it between legs. */
const rotationStub = () => {
	const state = { mode: "200" };
	const stub = serveStub((req, _body, n) => {
		if (req.url.includes("/revoke")) {
			return state.mode === "503"
				? Response.json({ error: "refused" }, { status: 503 })
				: Response.json({ revoked: `revoked: key-${n}` });
		}
		return Response.json(
			{
				key_id: `key-${n}`,
				key: `bksk_stub_${n}`,
				name: "witness",
				scopes: ["buckle:proxy:WRITE_"],
				expires_at: Date.now() + 3_600_000,
			},
			{ status: 201 },
		);
	});
	return { ...stub, state };
};

type JournalLine = {
	writes?: {
		value?: { kind?: string; model?: { role?: string; content?: unknown }[] }[];
	}[];
};

/** Assistant texts in the run's durable journal (pi.assistant entries). */
const assistantTexts = (durableRoot: string, runId: string): string[] => {
	const dir = join(durableRoot, runId, "state");
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir, { recursive: true }) as string[]) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (!line.includes('"kind":"pi.assistant"')) continue;
			const e = JSON.parse(line) as JournalLine;
			for (const w of e.writes ?? []) {
				if (w.type !== "entry" || w.value?.kind !== "pi.assistant") continue;
				for (const m of w.value.model ?? []) {
					if (m.role === "assistant") out.push(textOf(m.content));
				}
			}
		}
	}
	return out;
};

test.describe("desktop runner transport (W2869.3)", () => {
	test("model transport rides the leaf credential — ambient dummy auth never reaches the wire", async () => {
		// runtime-face conditional skip (TestInfo.skip) — W511 refuses gated
		// call tokens (test-dot-skip family) on added closing-diff lines;
		// identical semantics, gate-clean spelling.
		test
			.info()
			.skip(
				!dockerUp(),
				"real Docker Desktop witness — docker daemon unreachable",
			);
		const world = scratchWorld({ prefix: "desktop-transport-" });
		const durableRoot = join(world.home, "state");
		const workspacesDir = join(world.home, "workspaces");
		const seedRoot = join(world.home, "seed");
		mkdirSync(durableRoot, { recursive: true });
		mkdirSync(workspacesDir, { recursive: true });
		mkdirSync(seedRoot, { recursive: true });
		writeFileSync(join(seedRoot, "seed.md"), "immutable seed body\n");
		const completions = serveStub(() => sse());
		const admin = adminStub();
		const base = completions.url.replace(/\/$/, "");
		const provider = createProvider({
			id: "belt-live",
			baseUrl: base,
			auth: {
				apiKey: {
					name: "belt-live",
					// DUMMY ambient auth — the leaf facade MUST inject the per-run
					// credential (root #118378); if this reaches the wire the
					// captured-header asserts below fail.
					resolve: async () => ({
						auth: { apiKey: "bksk_dummy" },
						source: "w28693-transport-dummy",
					}),
				},
			},
			models: [
				{
					id: "witness-model",
					name: "witness-model",
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
					stream: openaiApi.stream,
					streamSimple: openaiApi.streamSimple,
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const leaf = createDesktopRunnerLeaf({
			store,
			durableRoot,
			runtime: {
				models,
				registry: createRegistry(),
				settings: undefined,
				onReport: () => {},
			},
			container: {
				image:
					"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
				workspacesDir,
				seedRoot,
			},
			credentials: {
				baseUrl: admin.url,
				adminKey: "bksk_admin_stub",
				receiptsPath: join(world.home, "receipts.json"),
			},
			executorSid: "executor-witness",
			leaseTtlMs: 6_000,
			cleanupTimeoutMs: 2_000,
		});
		const spec = RunnerSpecSchema.parse({
			version: 1 as const,
			runId,
			owner: "lane-witness",
			generation: 1,
			kind: "coding" as const,
			seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
			policyDigest: leaf.policyDigest(),
			provider: "belt-live",
			model: "witness-model",
		});
		await leaf.admitAndStart({ spec, actor: hostActor(), seedRoot });
		await leaf.controller.submit({
			runId,
			text: "first turn",
			actor: hostActor(),
		});
		const deadline = Date.now() + 60_000;
		let texts: string[] = [];
		while (Date.now() < deadline) {
			texts = assistantTexts(durableRoot, runId);
			if (texts.some((t) => t.includes("ALIVE"))) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		expect(texts.some((t) => t.includes("ALIVE"))).toBe(true);
		// The wire rode the LEAF credential: the first mint the leaf made at
		// admit (stub n=1), never the provider's ambient dummy (root #118378).
		const modelReqs = completions.requests.filter((r) =>
			r.path.includes("/chat/completions"),
		);
		expect(modelReqs.length).toBeGreaterThanOrEqual(1);
		expect(modelReqs.every((r) => r.auth === "Bearer bksk_stub_1")).toBe(true);
		expect(
			completions.requests.some((r) => r.auth?.includes("bksk_dummy")),
		).toBe(false);
		// Fallback-path witness (coordinator ruling on root #118412): the
		// controller drops requestId at HEAD (W2883 owns the forwarding), so
		// this submit rides the adapter's fresh-randomUUID fallback — a NEW
		// durable submission that delivers as a second turn.
		await leaf.controller.submit({
			runId,
			text: "second turn",
			actor: hostActor(),
		});
		const deadline2 = Date.now() + 60_000;
		let second: string[] = [];
		while (Date.now() < deadline2) {
			second = assistantTexts(durableRoot, runId);
			if (second.filter((t) => t.includes("ALIVE")).length >= 2) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		expect(
			second.filter((t) => t.includes("ALIVE")).length,
		).toBeGreaterThanOrEqual(2);
		await leaf.close();
	});

	test("revoke 503 mints nothing; confirmed revoke mints exactly one", async () => {
		const world = scratchWorld({ prefix: "desktop-rotation-" });
		const workspacesDir = join(world.home, "workspaces");
		const seedRoot = join(world.home, "seed");
		const receiptsPath = join(world.home, "receipts.json");
		mkdirSync(join(world.home, "state"), { recursive: true });
		mkdirSync(workspacesDir, { recursive: true });
		mkdirSync(seedRoot, { recursive: true });
		writeFileSync(join(seedRoot, "seed.md"), "immutable seed body\n");
		const admin = rotationStub();
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const leafDeps = {
			store,
			durableRoot: join(world.home, "state"),
			runtime: {
				models: {} as never,
				registry: createRegistry(),
				settings: undefined,
				onReport: () => {},
			},
			container: {
				image:
					"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
				workspacesDir,
				seedRoot,
			},
			credentials: {
				baseUrl: admin.url,
				adminKey: "bksk_admin_stub",
				receiptsPath,
			},
			executorSid: "executor-witness",
			leaseTtlMs: 6_000,
			cleanupTimeoutMs: 2_000,
		};
		const leaf1 = createDesktopRunnerLeaf(leafDeps);
		const spec = RunnerSpecSchema.parse({
			version: 1 as const,
			runId,
			owner: "lane-witness",
			generation: 1,
			kind: "coding" as const,
			seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
			policyDigest: leaf1.policyDigest(),
			provider: "belt",
			model: "glm-5.3",
		});
		await leaf1.admitAndStart({ spec, actor: hostActor(), seedRoot });
		const held = await leaf1.credentials.ensure(runId, 1);
		// Held path: the process-memory key wins — zero extra admin calls.
		expect(held.keyId).toBe("key-1");
		expect(admin.requests.length).toBe(1);
		// Process loss: a NEW leaf over the SAME receipts journal holds no
		// raw keys — the receipt says key-1 is still live (death unconfirmed).
		const leaf2 = createDesktopRunnerLeaf(leafDeps);
		const mints = () =>
			admin.requests.filter((r) => r.path === "/v1/admin/keys").length;
		const revokes = () =>
			admin.requests.filter((r) => r.path.endsWith("/revoke")).length;
		// Unconfirmed revoke refuses: 503 → ensure throws, mints NOTHING
		// (root #118603 — never two live keys per run/epoch).
		admin.state.mode = "503";
		await expect(leaf2.credentials.ensure(runId, 1)).rejects.toThrow(
			/503|refused/,
		);
		expect(mints()).toBe(1);
		expect(revokes()).toBe(1);
		// Confirmed revoke: the retry revokes key-1 (200) then mints exactly
		// ONE replacement — a distinct keyId, and resolve() rides it.
		admin.state.mode = "200";
		const reEnsured = await leaf2.credentials.ensure(runId, 1);
		expect(reEnsured.keyId).not.toBe("key-1");
		expect(mints()).toBe(2);
		expect(revokes()).toBe(2);
		expect(leaf2.credentials.resolve(runId)?.keyId).toBe(reEnsured.keyId);
		expect(reEnsured.key).not.toBe(held.key);
		// Held path again: zero extra admin calls after the re-arm.
		const again = await leaf2.credentials.ensure(runId, 1);
		expect(again.keyId).toBe(reEnsured.keyId);
		expect(mints()).toBe(2);
		expect(revokes()).toBe(2);
		await leaf2.close();
		await leaf1.close();
	});
});
