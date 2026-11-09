// runner-service-witness.e2e.ts — W2880: the desktop runner service witness
// over the REAL service face (openRunnerHost / runRunnerService + the merged
// desktopRuntime composition + real Docker sandbox), NEVER the live :7810
// instance — root owns that verification. Legs:
//   Wire witness (stub runtime, no Docker): unauthenticated health face +
//   scoped admit deny → admit → read → reader attach/replay/detach → abort
//   refuses further submits → the OUTSIDE-PROCESS sidecar
//   (bin/runner-control-health.ts + deploy/healthcheck/probe.ts child)
//   flips down on service death and up on reopen.
//   Docker witness (child-process service riding the REAL serve path —
//   runRunnerService + desktopRuntime under KLH_SETTINGS): scoped admit →
//   submit → desktop_sandbox_exec tool round-trip (the stub hub sees the
//   tool result on the wire) → workspace retained across process death →
//   missing workspace refuses reopen (runner.recovery_refused).
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerSettingsSchema } from "@klh/settings";
import {
	freePort,
	scratchWorld,
	serveStub,
	type ServeStub,
	waitUp,
} from "@klh/test-kit";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import {
	buildSeedBundle,
	snapshotDigest,
} from "../hooks/lib/runners/desktop/seed.ts";
import { RUNNER_SCOPES } from "../hooks/lib/runners/control/rights.ts";
import { resolvedPolicyDigest } from "../hooks/lib/runners/desktop/docker-executor.ts";
import type { RunnerIdentity } from "../hooks/lib/runners/api/identity.ts";
import { openRunnerHost } from "../hooks/lib/runners/service/host.ts";
import { runnerHostConfig } from "../hooks/lib/runners/service/config.ts";
import { desktopRuntime } from "../hooks/lib/runners/service/desktop-runtime.ts";

const dockerUp = (): boolean =>
	Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode === 0;

const ALPINE =
	"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b";
const TOOL = "desktop_sandbox_exec";
const MARKER = "w2880-witness-tool";
const laneToken = "lane-witness-key";
const readerToken = "reader-witness-key";
const mintToken = "bksk_witness_mint";
const IDS: Record<string, { key_id: string; scopes: string[] }> = {
	[laneToken]: {
		key_id: "lane-witness",
		scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
	},
	[readerToken]: {
		key_id: "reader-witness",
		scopes: [RUNNER_SCOPES.read, "buckle:admin:READ_"],
	},
	// The desktop mint authority's own key — the preflight presents it to
	// the identity face and demands buckle:admin:WRITE_.
	[mintToken]: {
		key_id: "mint-witness",
		scopes: ["buckle:admin:WRITE_"],
	},
};
const holds: ReadableStreamDefaultController[] = [];

/** OpenAI-wire SSE chunk builder for the stub hub. */
const chunk = (delta: unknown, finish: string | null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-w2880",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: "witness-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

const toolCallSse = (): string =>
	`${chunk(
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					index: 0,
					id: "call_witness",
					type: "function",
					function: {
						name: TOOL,
						arguments: JSON.stringify({ argv: ["/bin/echo", MARKER] }),
					},
				},
			],
		},
		"tool_calls",
	)}data: [DONE]\n\n`;

const aliveSse = (): string =>
	`${chunk({ role: "assistant", content: `ALIVE ${MARKER}` }, "stop")}data: [DONE]\n\n`;

/** Never-ending SSE — the body stays open so the pi turn cannot complete
 *  and the job stays `running` while the witness kills the service child. */
const holdSse = (): Response => {
	const body = new ReadableStream({
		start(c) {
			holds.push(c);
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};

/** Identity face: per-bearer-token key ids and scopes (the runner rides the
 *  real whoami wire contract via createRunnerIdentity). */
const whoamiFace = (req: {
	path: string;
	auth: string | null;
}): Response | undefined => {
	// "/" answers the mint authority's bare-base-URL identity probe; the
	// runner wire rides /v1/fleet/whoami.
	if (req.path !== "/v1/fleet/whoami" && req.path !== "/") return undefined;
	const entry = IDS[(req.auth ?? "").replace(/^Bearer /, "")];
	if (!entry) return Response.json({ error: "x" }, { status: 401 });
	return Response.json({
		authenticated: true,
		kind: "api_key",
		key_id: entry.key_id,
		team: null,
		actor: null,
		scopes: entry.scopes,
	});
};

/** Admin face: mint 201 / revoke 200 — the leaf's per-run credential path
 *  through the service's mint authority (never an ambient key). */
const adminFace = (
	mints: { keyId: string }[],
): ((req: { path: string; body: unknown }) => Response) => {
	const handler = (req: { path: string; body: unknown }): Response => {
		if (req.path === "/v1/admin/keys" && req.body !== null) {
			const keyId = `leaf-${mints.length + 1}`;
			mints.push({ keyId });
			return Response.json(
				{
					key_id: keyId,
					key: `bksk_leaf_${mints.length}`,
					name: "w2880-witness",
					scopes: ["buckle:proxy:WRITE_"],
					expires_at: Date.now() + 3_600_000,
				},
				{ status: 201 },
			);
		}
		if (req.path.endsWith("/revoke"))
			return Response.json({ revoked: req.path });
		return Response.json({ error: "x" }, { status: 404 });
	};
	return handler;
};

/** Model hub face: completions call 1 = tool call, 2 = final ALIVE answer
 *  (the tool result must have arrived on the wire by then), 3+ = held open
 *  (the in-flight run the service child dies on). */
const completionsFace = (toolResults: string[]) => {
	let seen = 0;
	return (req: {
		path: string;
		body: Record<string, unknown> | null;
	}): Response => {
		if (!req.path.includes("/chat/completions"))
			return Response.json({ error: "x" }, { status: 404 });
		seen++;
		if (seen === 1) return sseOf(toolCallSse());
		if (seen === 2) {
			const messages = (req.body?.messages ?? []) as {
				role?: string;
				content?: unknown;
			}[];
			if (
				messages.some(
					(m) =>
						m.role === "tool" &&
						JSON.stringify(m.content ?? "").includes(MARKER),
				)
			)
				toolResults.push(MARKER);
			return sseOf(aliveSse());
		}
		return holdSse();
	};
};

const sseOf = (body: string): Response =>
	new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

/** One stub hub: whoami identity + admin mint/revoke + the scripted
 *  completions tool round-trip, all on one origin. */
const hubStub = (): {
	stub: ServeStub;
	mints: { keyId: string }[];
	toolResults: string[];
} => {
	const mints: { keyId: string }[] = [];
	const toolResults: string[] = [];
	const completions = completionsFace(toolResults);
	const admin = adminFace(mints);
	const stub = serveStub((req, body) => {
		const path = new URL(req.url).pathname;
		const auth = req.headers.get("authorization");
		const who = whoamiFace({ path, auth });
		if (who) return who;
		if (path.includes("/v1/admin/keys")) return admin({ path, body });
		return completions({ path, body });
	});
	return { stub, mints, toolResults };
};

/** Stage the host: a private seed root + digest-pinned bundle, and the
 *  profiles file binding the bundle digests. */
const stageSeed = async (
	world: ReturnType<typeof scratchWorld>,
): Promise<{ seedRoot: string; seedDigest: string }> => {
	const seedRoot = join(world.home, "seed");
	mkdirSync(seedRoot, { mode: 0o700 });
	writeFileSync(join(seedRoot, "system.md"), "# w2880 witness seed\n", {
		mode: 0o600,
	});
	const bundle = await buildSeedBundle({
		seedRoot,
		policyJson: JSON.stringify({ tools: [TOOL], marker: MARKER }),
		runtimeImage: ALPINE,
	});
	// The executor's CANONICAL policy digest — buildSeedBundle's
	// digestOf(policyJson) is a different shape; the executor refuses
	// launch on any drift (policy drift check in startRun).
	const policyDigest = resolvedPolicyDigest({
		image: ALPINE,
		seedRoot,
		workspacesDir: join(world.home, "state", "workspaces"),
	});
	writeFileSync(
		join(world.home, "profiles.json"),
		JSON.stringify({
			standard: {
				version: 1,
				generation: 1,
				kind: "coding",
				seedDigest: bundle.seedDigest,
				policyDigest,
				provider: "belt",
				model: "witness-model",
			},
		}),
		{ mode: 0o600 },
	);
	return { seedRoot, seedDigest: bundle.seedDigest };
};

/** The service settings file: 0600, machine-conf shape, pointing the
 *  runner at the stub hub and the staged private paths. */
const stageSettings = (
	world: ReturnType<typeof scratchWorld>,
	controlUrl: string,
	identityUrl: string,
	seedRoot: string,
): string => {
	const settingsFile = join(world.home, "settings.json");
	// The 0600 key files the machine-conf law requires: the control plane's
	// bearer credential and the desktop mint authority's private key (the
	// preflight refuses an ambient/shared mint credential).
	writeFileSync(join(world.home, "control.key"), "bksk_witness_control", {
		mode: 0o600,
	});
	writeFileSync(join(world.home, "mint.key"), "bksk_witness_mint", {
		mode: 0o600,
	});
	writeFileSync(
		settingsFile,
		JSON.stringify({
			runner: {
				control_url: controlUrl,
				identity_url: identityUrl,
				credential_file: join(world.home, "control.key"),
				profiles_file: join(world.home, "profiles.json"),
				state_dir: join(world.home, "state"),
				desktop: {
					image: ALPINE,
					seed_root: seedRoot,
					mint_credential_file: join(world.home, "mint.key"),
				},
			},
		}),
		{ mode: 0o600 },
	);
	return settingsFile;
};

/** Spawn the child service on the REAL serve path: runRunnerService +
 *  desktopRuntime composed under KLH_SETTINGS, exactly like the installed
 *  service entry. */
const spawnService = (
	world: ReturnType<typeof scratchWorld>,
	settingsFile: string,
) => {
	const lib = new URL("../hooks/lib/runners/", import.meta.url).href;
	return Bun.spawn(
		[
			process.execPath,
			"-e",
			[
				`import { runRunnerService } from ${JSON.stringify(`${lib}service/process.ts`)};`,
				`import { desktopRuntime } from ${JSON.stringify(`${lib}service/desktop-runtime.ts`)};`,
				'import { settings } from "@klh/settings";',
				"const runner = settings({ mode: 'service' }).runner;",
				"const runtime = await desktopRuntime(runner, runner.state_dir);",
				"await runRunnerService(runtime);",
			].join("\n"),
		],
		{
			env: {
				...world.env,
				KLH_SETTINGS: settingsFile,
				// HOME is the scratch world — the docker CLI would not find
				// ~/.docker there, so the desktop-linux context (preflight
				// inspect) and the plain-docker executor both need the real
				// config dir pinned.
				DOCKER_CONFIG: join(process.env.HOME ?? "", ".docker"),
			},
			stdout: "pipe",
			stderr: "inherit",
			stdin: "ignore",
		},
	);
};

/** Bounded wait for a witness condition (30s default budget). */
const until = async (
	probe: () => boolean | Promise<boolean>,
	label: string,
	tries = 150,
): Promise<void> => {
	for (let i = 0; i < tries; i++) {
		if (await probe()) return;
		await Bun.sleep(200);
	}
	throw new Error(`witness: ${label} never settled`);
};

const containerNameOf = (runId: string): string =>
	`fleet-runner-${runId.replaceAll("-", "").slice(0, 16)}`;

/** Make sure the digest-pinned image is in the local Desktop cache —
 *  the preflight inspects only, it never pulls. */
const ensureImage = (image: string): void => {
	const inspect = Bun.spawnSync(
		[
			"docker",
			"--context",
			"desktop-linux",
			"image",
			"inspect",
			"--format",
			"{{.Id}}",
			"--",
			image,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (inspect.exitCode === 0) return;
	const pull = Bun.spawnSync(["docker", "pull", image], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
	});
	if (pull.exitCode !== 0)
		throw new Error(`witness: docker pull failed for ${image}`);
};

/** Reap only THIS witness's containers — never a name-prefix sweep (the
 *  live :7810 runner owns real containers under the same prefix). */
const reapContainers = (runIds: readonly string[]): void => {
	for (const runId of runIds)
		Bun.spawnSync(["docker", "rm", "-f", containerNameOf(runId)], {
			stdout: "pipe",
			stderr: "pipe",
		});
};

type WireApi = (path: string, init?: RequestInit) => Promise<Response>;
type RunnerIdentityFn = (request: Request) => Promise<RunnerIdentity>;

/** The in-process wire host over a stub runtime (no Docker): open once,
 *  run the authorization + lifecycle legs, stop. */
const wireLegs = async (
	world: ReturnType<typeof scratchWorld>,
	identity: RunnerIdentityFn,
): Promise<WireApi> => {
	const options: Parameters<typeof openRunnerHost>[0] = {
		stateDir: join(world.home, "state"),
		profilesFile: join(world.home, "profiles.json"),
		port: 0,
		identity,
		openRuntime: async ({ store }) => ({
			controller: openRunnerController({ store }),
			async close() {},
		}),
	};
	const host = await openRunnerHost(options);
	const api: WireApi = (path, init) => fetch(new URL(path, host.url), init);
	await wireLegsCore(api);
	return api;
};

/** The authorization + lifecycle legs against the live wire face. */
const wireLegsCore = async (api: WireApi): Promise<void> => {
	// Health answers WITHOUT any credential; everything else still demands
	// identity (an expired key can never break liveness reporting).
	expect((await api("/v1/runner/health")).status).toBe(200);
	expect((await api("/v1/runner/runs")).status).toBe(401);
	// A READ_-only key may never admit (scoped deny).
	const denied = await api("/v1/runner/runs", {
		method: "POST",
		headers: { authorization: `Bearer ${readerToken}` },
		body: JSON.stringify({ profile: "standard", runId: crypto.randomUUID() }),
	});
	expect(denied.status).toBe(403);
	// Scoped admit + owner read.
	const runA = crypto.randomUUID();
	const admit = await api("/v1/runner/runs", {
		method: "POST",
		headers: { authorization: `Bearer ${laneToken}` },
		body: JSON.stringify({ profile: "standard", runId: runA }),
	});
	expect(admit.status).toBe(201);
	const read = await api(`/v1/runner/runs/${runA}`, {
		headers: { authorization: `Bearer ${laneToken}` },
	});
	expect(read.status).toBe(200);
	// A READ_+admin-READ key attaches, replays, detaches (the reader path).
	for (const action of ["attach", "replay", "detach"]) {
		const res = await api(`/v1/runner/runs/${runA}/${action}`, {
			method: "POST",
			headers: { authorization: `Bearer ${readerToken}` },
			body: JSON.stringify({ readerId: crypto.randomUUID() }),
		});
		expect(res.status).toBe(200);
	}
};

/** Abort closes the run; a later submit refuses (lifecycle terminal). */
const wireAbortLeg = async (api: WireApi): Promise<void> => {
	const runA = crypto.randomUUID();
	const admit = await api("/v1/runner/runs", {
		method: "POST",
		headers: { authorization: `Bearer ${laneToken}` },
		body: JSON.stringify({ profile: "standard", runId: runA }),
	});
	expect(admit.status).toBe(201);
	const abort = await api(`/v1/runner/runs/${runA}/abort`, {
		method: "POST",
		headers: { authorization: `Bearer ${laneToken}` },
		body: "{}",
	});
	expect(abort.status).toBe(200);
	const submit = await api(`/v1/runner/runs/${runA}/submit`, {
		method: "POST",
		headers: { authorization: `Bearer ${laneToken}` },
		body: JSON.stringify({ requestId: "post-abort", text: "hello" }),
	});
	expect(submit.ok).toBe(false);
	expect(submit.status).toBeGreaterThanOrEqual(400);
};

const HEALTH_BIN = fileURLToPath(
	new URL("../hooks/bin/runner-control-health.ts", import.meta.url),
);

/** Spawn the wrapper sidecar (witness overrides only; staged units ride
 *  the probe defaults). */
const spawnHealthSidecar = (
	world: ReturnType<typeof scratchWorld>,
	settingsFile: string,
) =>
	Bun.spawn(
		[
			process.execPath,
			HEALTH_BIN,
			"--every",
			"250",
			"--timeout",
			"500",
			"--misses",
			"1",
		],
		{
			env: { ...world.env, KLH_SETTINGS: settingsFile },
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		},
	);

/** The sidecar setup: a fixed-port host + the wrapper child watching the
 *  unauth health face on port+1. */
const sidecarLeg = async (
	world: ReturnType<typeof scratchWorld>,
	identity: RunnerIdentityFn,
	seedRoot: string,
): Promise<void> => {
	const port = await freePort();
	const controlUrl = `http://127.0.0.1:${port}`;
	const settingsFile = stageSettings(world, controlUrl, controlUrl, seedRoot);
	const options: Parameters<typeof openRunnerHost>[0] = {
		stateDir: join(world.home, "state2"),
		profilesFile: join(world.home, "profiles.json"),
		port,
		identity,
		openRuntime: async ({ store }) => ({
			controller: openRunnerController({ store }),
			async close() {},
		}),
	};
	const wrapper = spawnHealthSidecar(world, settingsFile);
	try {
		await sidecarDeathLeg(options, wrapper, port);
	} finally {
		if (wrapper.exitCode === null) wrapper.kill("SIGKILL");
	}
};

/** Death + reopen while the probe sidecar watches from its own port. */
const sidecarDeathLeg = async (
	options: Parameters<typeof openRunnerHost>[0],
	wrapper: Bun.Subprocess,
	port: number,
): Promise<void> => {
	let host = await openRunnerHost(options);
	// Real service death — the sidecar must report DOWN: a wedged served
	// process can never paint itself healthy.
	await host.stop();
	await until(async () => {
		try {
			const res = await fetch(`http://127.0.0.1:${port + 1}/healthz`, {
				signal: AbortSignal.timeout(500),
			});
			return !res.ok;
		} catch {
			return true;
		}
	}, "sidecar flips down after service death");
	host = await openRunnerHost(options);
	await waitUp(`http://127.0.0.1:${port + 1}/healthz`, { tries: 30 });
	wrapper.kill("SIGTERM");
	expect(await wrapper.exited).toBe(0);
	await host.stop();
};

/** Shared state bag for the docker witness legs. */
interface DockerWitness {
	world: ReturnType<typeof scratchWorld>;
	settingsFile: string;
	controlUrl: string;
	auth: { authorization: string };
	runIds: string[];
	child: ReturnType<typeof spawnService>;
	toolResults: string[];
	mints: { keyId: string }[];
	seedDigest: string;
}

/** Reopen the host IN-PROCESS over the same state dir: the merged
 *  desktopRuntime composition + the real identity authority face. */
const reopenRunner = async (w: DockerWitness) => {
	const parsed = RunnerSettingsSchema.parse(
		JSON.parse(await Bun.file(w.settingsFile).text()).runner,
	);
	const runtime = await desktopRuntime(parsed, parsed.state_dir);
	return openRunnerHost({
		...runnerHostConfig(parsed),
		openRuntime: runtime.openRuntime,
	});
};

/** Leg A: scoped deny, admit, submit — the turn rides the REAL
 *  desktop_sandbox_exec container executor. */
const dockerLegA = async (w: DockerWitness): Promise<void> => {
	const api: WireApi = (path, init) => fetch(new URL(path, w.controlUrl), init);
	const denied = await api("/v1/runner/runs", {
		method: "POST",
		headers: { authorization: `Bearer ${readerToken}` },
		body: JSON.stringify({ profile: "standard", runId: crypto.randomUUID() }),
	});
	expect(denied.status).toBe(403);
	const runA = crypto.randomUUID();
	w.runIds.push(runA);
	const admit = await api("/v1/runner/runs", {
		method: "POST",
		headers: w.auth,
		body: JSON.stringify({ profile: "standard", runId: runA }),
	});
	expect(admit.status).toBe(201);
	const submit = await api(`/v1/runner/runs/${runA}/submit`, {
		method: "POST",
		headers: w.auth,
		body: JSON.stringify({ requestId: "witness-a", text: `echo ${MARKER}` }),
	});
	expect(submit.status).toBe(200);
};

/** Retention leg: the stub hub must see the tool result arrive, then the
 *  child dies a REAL process death (SIGKILL — a graceful leaf close would
 *  close every live run) and the in-process reopen must find run A's
 *  verified workspace intact. */
const dockerRetentionLeg = async (w: DockerWitness): Promise<void> => {
	const runA = w.runIds[0];
	await until(() => w.toolResults.length >= 1, "tool result round-trip");
	await until(
		() => existsSync(join(w.world.home, "state", "workspaces", runA)),
		"run A workspace materialized",
	);
	w.child.kill("SIGKILL");
	await w.child.exited;
	const host = await reopenRunner(w);
	try {
		const read = await fetch(new URL(`/v1/runner/runs/${runA}`, host.url), {
			headers: w.auth,
		});
		expect(read.status).toBe(200);
		expect(
			await snapshotDigest(
				join(w.world.home, "state", "workspaces", runA, "seed"),
			),
		).toBe(w.seedDigest);
	} finally {
		await host.stop();
	}
};

/** Run B held mid-flight on the stub hub; the child dies on it. */
const dockerHoldLeg = async (w: DockerWitness): Promise<void> => {
	w.child = spawnService(w.world, w.settingsFile);
	await waitUp(`${w.controlUrl}/v1/runner/health`, { tries: 100 });
	const api: WireApi = (path, init) => fetch(new URL(path, w.controlUrl), init);
	const runB = crypto.randomUUID();
	w.runIds.push(runB);
	const admit = await api("/v1/runner/runs", {
		method: "POST",
		headers: w.auth,
		body: JSON.stringify({ profile: "standard", runId: runB }),
	});
	expect(admit.status).toBe(201);
	const submit = await api(`/v1/runner/runs/${runB}/submit`, {
		method: "POST",
		headers: w.auth,
		body: JSON.stringify({ requestId: "witness-b", text: "hold" }),
	});
	expect(submit.status).toBe(200);
	await until(() => holds.length >= 1, "run B held mid-flight");
	w.child.kill("SIGKILL");
	await w.child.exited;
};

/** Workspace-loss leg: admit materialized run B's snapshot; deleting it
 *  must make the whole reopen refuse (fail closed, runner.recovery_refused). */
const dockerLossLeg = async (w: DockerWitness): Promise<void> => {
	const runB = w.runIds[w.runIds.length - 1];
	rmSync(join(w.world.home, "state", "workspaces", runB), {
		recursive: true,
		force: true,
	});
	await expect(reopenRunner(w)).rejects.toThrow(/recovery_refused/);
	// The per-run mint credential rode the round-trip through the admin
	// face — scoped mint evidence, never an ambient key.
	expect(w.mints.length).toBeGreaterThanOrEqual(1);
};

const dockerWitnessOf = (
	world: ReturnType<typeof scratchWorld>,
	mints: { keyId: string }[],
	toolResults: string[],
	seedDigest: string,
	controlUrl: string,
	settingsFile: string,
): DockerWitness => ({
	world,
	settingsFile,
	controlUrl,
	auth: { authorization: `Bearer ${laneToken}` },
	runIds: [],
	child: undefined as unknown as ReturnType<typeof spawnService>,
	toolResults,
	mints,
	seedDigest,
});

test("wire witness: unauth health face, scoped deny, admit/read/reader, abort refuses submits, sidecar flips down and up @unit", async () => {
	const world = scratchWorld({ prefix: "runner-witness-" });
	const { stub } = hubStub();
	const { seedRoot } = await stageSeed(world);
	const identity: RunnerIdentityFn = async (request) => {
		const token = (request.headers.get("authorization") ?? "").replace(
			/^Bearer /,
			"",
		);
		const entry = IDS[token];
		if (!entry) throw new Error("runner.unauthorized");
		return { keyId: entry.key_id, kind: "api_key", scopes: entry.scopes };
	};
	try {
		const api = await wireLegs(world, identity);
		await wireAbortLeg(api);
		await sidecarLeg(world, identity, seedRoot);
	} finally {
		stub.close();
		world.clean();
	}
});

test("docker witness: tool round-trip, workspace retention across process death, workspace loss refuses reopen @unit", async () => {
	test.info().skip(!dockerUp(), "Docker Desktop not reachable");
	const world = scratchWorld({ prefix: "runner-witness-docker-" });
	const { stub, mints, toolResults } = hubStub();
	const { seedRoot, seedDigest } = await stageSeed(world);
	const port = await freePort();
	ensureImage(ALPINE);
	const controlUrl = `http://127.0.0.1:${port}`;
	const settingsFile = stageSettings(world, controlUrl, stub.url, seedRoot);
	const w = dockerWitnessOf(
		world,
		mints,
		toolResults,
		seedDigest,
		controlUrl,
		settingsFile,
	);
	try {
		w.child = spawnService(world, settingsFile);
		await waitUp(`${w.controlUrl}/v1/runner/health`, { tries: 100 });
		await dockerLegA(w);
		await dockerRetentionLeg(w);
		await dockerHoldLeg(w);
		await dockerLossLeg(w);
	} finally {
		if (w.child?.exitCode === null) w.child.kill("SIGKILL");
		reapContainers(w.runIds);
		for (const hold of holds.splice(0)) {
			try {
				hold.close();
			} catch {
				// Already closed when its request died with the service child.
			}
		}
		stub.close();
		world.clean();
	}
});
