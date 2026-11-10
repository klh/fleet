// Run with bun test/runner-linux-preflight.fixture.ts from packages/suspenders.
// Requires the pinned local image; never pulls, and never mounts a daemon socket.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";

const image =
	"oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const digest = "a".repeat(64);
const pinnedImage = `fixture@sha256:${digest}`;
const world = scratchWorld({ prefix: "linux-runner-preflight-" });

try {
	const file = (name: string, text: string, mode = 0o600) =>
		writeFileSync(join(world.home, name), text, { mode });
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../hooks/bin/runner-control.ts")],
		target: "bun",
	});
	if (!build.success || build.outputs.length !== 1)
		throw new Error("Runner bundle failed");
	file("runner.js", await build.outputs[0].text());
	mkdirSync(join(world.home, "seed"), { mode: 0o700 });
	file("mint.key", "fixture-mint\n");
	file("reader.key", "fixture-reader\n");
	file(
		"settings.json",
		JSON.stringify({
			runner: {
				control_url: "http://127.0.0.1:7810",
				identity_url: "http://127.0.0.1:18110",
				credential_file: "/fixture/reader.key",
				profiles_file: "/fixture/profiles.json",
				state_dir: "/tmp/runner-state",
				desktop: {
					image: pinnedImage,
					seed_root: "/fixture/seed",
					mint_credential_file: "/fixture/mint.key",
				},
			},
		}),
	);
	file(
		"profiles.json",
		JSON.stringify({
			standard: {
				version: 1,
				generation: 1,
				kind: "coding",
				seedDigest: digest,
				policyDigest: "b".repeat(64),
				provider: "belt",
				model: "fixture",
			},
		}),
	);
	file(
		"docker",
		`#!/bin/sh
[ "$1" = "--host" ] && [ "$2" = "unix:///var/run/docker.sock" ] || exit 71
if [ "$3" = "info" ]; then
  if [ "$FIXTURE_NO_CFS" = "1" ]; then
    printf '%s\\n' '["WARNING: No cpu cfs quota support"]'
  else
    printf '%s\\n' null
  fi
  exit 0
fi
[ "$3" = "image" ] && [ "$4" = "inspect" ] && [ "$8" = "${pinnedImage}" ] || exit 71
printf 'sha256:${digest}\\n'
`,
		0o700,
	);
	file(
		"probe.ts",
		`
import { existsSync } from "node:fs";
if (process.platform !== "linux" || existsSync("/var/run/docker.sock"))
	throw new Error("fixture requires Linux without a daemon socket");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 18110,
	fetch(request) {
		if (new URL(request.url).pathname !== "/v1/fleet/whoami" ||
			request.headers.get("authorization") !== "Bearer fixture-mint")
			return new Response(null, { status: 403 });
		return Response.json({
			authenticated: true, kind: "api_key", key_id: "fixture",
			team: null, actor: null, scopes: ["buckle:admin:WRITE_"],
		});
	},
});
try {
	const childEnv = {
		...process.env, KLH_SETTINGS: "/fixture/settings.json",
		PATH: "/fixture:" + process.env.PATH,
		DOCKER_HOST: "tcp://127.0.0.1:9",
	};
	const child = Bun.spawn([process.execPath, "/fixture/runner.js", "--check"], {
		env: childEnv,
		stdout: "pipe", stderr: "inherit",
	});
	const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	const result = JSON.parse(stdout);
	if (status || result.preflight !== "passed" || result.imageId !== "sha256:${digest}")
		throw new Error("Linux runner preflight did not pass");
	const refused = Bun.spawn([process.execPath, "/fixture/runner.js", "--check"], {
		env: { ...childEnv, FIXTURE_NO_CFS: "1" }, stdout: "ignore", stderr: "pipe",
	});
	const [reason, refusedStatus] = await Promise.all([new Response(refused.stderr).text(), refused.exited]);
	if (refusedStatus !== 1 ||
		reason.trim() !== "runner.docker_resource_limits_unavailable")
		throw new Error("Linux runner preflight did not refuse missing CPU quota");
	console.log(JSON.stringify({ ...result, platform: process.platform, arch: process.arch, fixture: true }));
} finally {
	server.stop(true);
}
`,
	);
	const child = Bun.spawn(
		[
			"docker",
			"run",
			"--rm",
			"--pull",
			"never",
			"--network",
			"none",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--user",
			`${process.getuid?.()}:${process.getgid?.()}`,
			"--mount",
			`type=bind,src=${world.home},dst=/fixture,readonly`,
			image,
			"bun",
			"/fixture/probe.ts",
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (await child.exited) throw new Error("Linux fixture failed");
} finally {
	world.clean();
}
