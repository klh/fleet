import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createMonitor } from "../healthcheck/probe.ts";
import { HostDeploymentSchema } from "./deployment.ts";
import { runnerHealth } from "./health.ts";
import { command, stageContext } from "./build.ts";
import {
	FlockSupervisorInputSchema,
	HostSupervisorDescriptorSchema,
	HOST_BUILD_PINS,
} from "./contract.ts";

test("HOST deployment rejects bridge networking, unstable identity and root @unit", () => {
	const config = {
		networkMode: "host",
		hostname: "fleet-node-01",
		uid: 1000,
		gid: 1000,
		socketGid: 998,
		settings: "/srv/fleet/settings.json",
		profiles: "/srv/fleet/profiles.json",
		controlKey: "/srv/fleet/control.key",
		mintKey: "/srv/fleet/mint.key",
		readerKey: "/srv/fleet/reader.key",
		state: "/srv/fleet/state",
		seed: "/srv/fleet/seeds",
		socket: "/run/docker.sock",
	};
	expect(HostDeploymentSchema.parse(config)).toEqual(config);
	for (const delta of [
		{ networkMode: "bridge" },
		{ hostname: "" },
		{ uid: 0 },
		{ state: "relative" },
		{ DOCKER_HOST: "tcp://broker:2375" },
	])
		expect(() => HostDeploymentSchema.parse({ ...config, ...delta })).toThrow();
});

test("health adapter reads a private key and performs only protected GET @unit", async () => {
	const world = scratchWorld();
	const keyFile = join(world.home, "reader.key");
	const stub = serveStub((request) =>
		request.method === "GET" &&
		request.headers.get("authorization") === "Bearer fixture-reader"
			? Response.json({ runs: [], nextCursor: null })
			: new Response(null, { status: 401 }),
	);
	try {
		await writeFile(keyFile, "fixture-reader", { mode: 0o600 });
		const { monitor } = runnerHealth({ target: stub.url, keyFile });
		await monitor.poll();
		expect(monitor.snapshot().ok).toBe(true);
		expect(stub.requests.map((request) => request.path)).toEqual([
			"/v1/runner/runs",
		]);
		expect(() =>
			runnerHealth({ target: "http://public.example", keyFile }),
		).toThrow();
	} finally {
		try {
			stub.close();
		} finally {
			world.clean();
		}
	}
});

test("shared monitor authenticates an injected protected GET and confirms failure @unit", async () => {
	let allowed = true;
	const stub = serveStub((request) =>
		allowed &&
		request.method === "GET" &&
		request.headers.get("authorization") === "Bearer fixture-reader"
			? Response.json({ runs: [], nextCursor: null })
			: new Response(null, { status: 401 }),
	);
	try {
		const monitor = createMonitor(
			{
				target: `${stub.url}/v1/runner/runs`,
				every: 5000,
				timeout: 1000,
				misses: 1,
				ring: 5,
			},
			{ headers: { authorization: "Bearer fixture-reader" }, expect: "runs" },
		);
		await monitor.poll();
		expect(monitor.snapshot().ok).toBe(true);
		allowed = false;
		await monitor.poll();
		expect(monitor.snapshot().state).toBe("down");
		expect(stub.requests).toHaveLength(3);
		expect(JSON.stringify(monitor.snapshot())).not.toContain("fixture-reader");
	} finally {
		stub.close();
	}
});

test("supervisor input preserves Flock's strict family/repository contract @unit", () => {
	const input = {
		schemaVersion: 1,
		family: "supervisor",
		version: "0.1.0-experimental.fixture",
		image: `ghcr.io/klh/fleet/supervisor-seed@sha256:${"a".repeat(64)}`,
		sourceCommit: "b".repeat(40),
		architecture: "amd64",
	};
	expect(FlockSupervisorInputSchema.parse(input)).toEqual(input);
	expect(() =>
		FlockSupervisorInputSchema.parse({ ...input, role: "host" }),
	).toThrow();
	expect(() =>
		FlockSupervisorInputSchema.parse({
			...input,
			image: input.image.replace("supervisor-seed", "tool-seed"),
		}),
	).toThrow();
	expect(() =>
		HostSupervisorDescriptorSchema.parse({ ...input, role: "tool" }),
	).toThrow();
	expect(HOST_BUILD_PINS.docker).toContain("@sha256:");
	const descriptor = {
		schemaVersion: 1,
		family: "supervisor",
		role: "host",
		service: "runner-control",
		version: input.version,
		image: input.image,
		sourceCommit: input.sourceCommit,
		recipeCommit: "c".repeat(40),
		architectures: ["amd64"],
		runtimeSmokePlatforms: [],
		producer: { name: "fleet", repository: "https://github.com/klh/fleet" },
		build: {
			bunImage: HOST_BUILD_PINS.bun,
			dockerCliImage: HOST_BUILD_PINS.docker,
			tool: "docker-buildx",
			provenance: "not-inspected",
			sbom: "not-inspected",
		},
		continuity: "not-inspected",
		flockInputs: [input],
	};
	expect(HostSupervisorDescriptorSchema.safeParse(descriptor).success).toBe(
		true,
	);
	expect(
		HostSupervisorDescriptorSchema.safeParse({
			...descriptor,
			flockInputs: [
				{
					...input,
					image: input.image.replace("a".repeat(64), "d".repeat(64)),
				},
			],
		}).success,
	).toBe(false);
});

test("HOST staging captures committed source and recipe independently and excludes live data @unit", async () => {
	const world = scratchWorld();
	let staged: Awaited<ReturnType<typeof stageContext>> | undefined;
	const git = (args: string[]) => command(["git", ...args], world.home);
	const commit = async () => {
		await git(["add", "."]);
		await git([
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"fixture",
		]);
		return (await git(["rev-parse", "HEAD"])).trim();
	};
	try {
		await git(["init"]);
		await writeFile(join(world.home, "source-marker"), "committed-source");
		const source = await commit();
		const recipeDir = join(world.home, "packages/suspenders/deploy/host");
		await mkdir(recipeDir, { recursive: true });
		for (const name of ["Dockerfile", "bundle.ts", "contract.ts", "health.ts"])
			await writeFile(join(recipeDir, name), `committed-${name}`);
		await mkdir(join(recipeDir, "../healthcheck"), { recursive: true });
		await writeFile(
			join(recipeDir, "../healthcheck/probe.ts"),
			"committed-probe",
		);
		const recipe = await commit();
		await writeFile(join(recipeDir, "Dockerfile"), "LIVE-MUTATION");
		await writeFile(join(world.home, "private-untracked"), "fixture-only");
		staged = await stageContext(source, recipe, world.home);
		expect(
			await Bun.file(join(staged.context, "source/source-marker")).text(),
		).toBe("committed-source");
		expect(await Bun.file(join(staged.context, "Dockerfile")).text()).toBe(
			"committed-Dockerfile",
		);
		expect(existsSync(join(staged.context, "source/.git"))).toBe(false);
		expect(existsSync(join(staged.context, "source/private-untracked"))).toBe(
			false,
		);
	} finally {
		try {
			await staged?.clean();
		} finally {
			world.clean();
		}
	}
});
