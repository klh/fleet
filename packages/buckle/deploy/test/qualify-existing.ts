import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { expect } from "@playwright/test";
import { freePort } from "@klh/test-kit";
import { z } from "zod";
import { fixture } from "./fixture.ts";
import { qualifyApi } from "./qualification-api.ts";
import {
	configureFallback,
	ModeSchema,
	qualifyNegative,
} from "./qualification-config.ts";
import {
	createQualificationDriver,
	readHttp,
	type ProcessRunner,
} from "./qualification.ts";

export const PUBLISHED_IMAGE =
	"ghcr.io/klh/fleet/buckle-seed@sha256:b57ec30f3582d298f4b465d3a8cd629ab3447b3b644dd26efde5a4cb0a062189";
const SOURCE = "f19dfe5ebedfeeb4739e675ec1c4b437c796ff03";
const PlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
const ContainerSchema = z
	.array(
		z.object({
			Image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
			ImageManifestDescriptor: z.object({
				digest: z.string(),
				platform: z.object({ architecture: z.string(), os: z.string() }),
			}),
			Config: z.object({ Image: z.literal(PUBLISHED_IMAGE), User: z.string() }),
			HostConfig: z.object({
				ReadonlyRootfs: z.literal(true),
				NanoCpus: z.literal(2000000000),
				Memory: z.literal(1610612736),
				PidsLimit: z.literal(256),
			}),
		}),
	)
	.length(1);
const ImageSchema = z
	.array(
		z.object({
			Id: z.string(),
			Descriptor: z.object({ mediaType: z.string() }),
			RootFS: z.object({
				Type: z.literal("layers"),
				Layers: z.array(z.string()),
			}),
			Architecture: z.enum(["amd64", "arm64"]),
			Os: z.literal("linux"),
			Config: z.object({ Labels: z.record(z.string(), z.string()) }),
		}),
	)
	.length(1);

/** Existing published payload qualification only. Never builds or publishes. */
export async function qualifyExisting(
	platformInput: unknown,
	run: ProcessRunner,
	modeInput: unknown = "main",
) {
	const platform = PlatformSchema.parse(platformInput),
		mode = ModeSchema.parse(modeInput),
		runId = randomUUID();
	const driver = createQualificationDriver(run, runId),
		data = await fixture();
	await chmod(data.world.home, 0o700);
	const ids: string[] = [],
		removed: string[] = [];
	const facts: Record<string, unknown> = {
		image: PUBLISHED_IMAGE,
		source: SOURCE,
		platform,
		runId,
		limits: { cpus: 2, memoryBytes: 1610612736, pids: 256 },
		syntheticUpstreamOnly: true,
	};
	let cleaned = false;
	let creationAttempted = false;
	let primaryFailure: Error | undefined;
	try {
		if (mode === "fallback") await configureFallback(data);
		const IndexSchema = z.object({
			manifests: z.array(
				z.object({
					digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
					platform: z.object({ os: z.string(), architecture: z.string() }),
				}),
			),
		});
		const index = IndexSchema.parse(
			JSON.parse(
				await driver.docker(
					["buildx", "imagetools", "inspect", "--raw", PUBLISHED_IMAGE],
					30000,
				),
			),
		);
		const matches = index.manifests.filter(
			(entry) =>
				entry.platform.os === "linux" &&
				entry.platform.architecture === platform.split("/")[1],
		);
		if (matches.length !== 1 || !matches[0])
			throw Error("Published platform manifest not unique");
		const manifest = z
			.object({
				config: z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
			})
			.parse(
				JSON.parse(
					await driver.docker(
						[
							"buildx",
							"imagetools",
							"inspect",
							"--raw",
							`ghcr.io/klh/fleet/buckle-seed@${matches[0].digest}`,
						],
						30000,
					),
				),
			);
		facts.platformManifest = matches[0].digest;
		facts.hostArchitecture = process.arch;
		facts.execution =
			platform === "linux/amd64" && process.arch === "arm64"
				? "Docker Desktop amd64 emulation"
				: "Docker Desktop platform observation";
		await driver.docker(
			["pull", "--platform", platform, PUBLISHED_IMAGE],
			120000,
		);
		const port = await freePort();
		creationAttempted = true;
		const cid = await driver.docker([
			"create",
			"--pull=never",
			"--platform",
			platform,
			"--name",
			`buckle-qualifier-${runId}`,
			"--label",
			`io.klh.seed.qualifier=${runId}`,
			"--cpus",
			"2",
			"--memory",
			"1536m",
			"--pids-limit",
			"256",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--tmpfs",
			"/data:rw,uid=1000,gid=1000",
			"--tmpfs",
			"/tmp:rw,uid=1000,gid=1000",
			"--env-file",
			`${data.world.home}/${mode === "neutral" ? "neutral" : mode === "unkeyed" ? "unauthenticated" : "runtime"}.env`,
			"--mount",
			`type=bind,source=${data.site},target=/site,readonly`,
			"--publish",
			`127.0.0.1:${port}:4101`,
			PUBLISHED_IMAGE,
		]);
		ids.push(
			z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.parse(cid),
		);
		await driver.owned(cid);
		const [container] = ContainerSchema.parse(
			JSON.parse(await driver.docker(["inspect", cid])),
		);
		if (!container) throw Error("Missing container identity");
		const [image] = ImageSchema.parse(
			JSON.parse(
				await driver.docker([
					"image",
					"inspect",
					"--platform",
					platform,
					container.Image,
				]),
			),
		);
		if (!image || image.Architecture !== platform.split("/")[1])
			throw Error("Image platform/config mismatch");
		const archive = `${data.world.home}/published-image.tar`;
		await driver.docker(
			[
				"image",
				"save",
				"--platform",
				platform,
				"--output",
				archive,
				PUBLISHED_IMAGE,
			],
			120000,
		);
		async function readBlob(digest: string) {
			z.string()
				.regex(/^sha256:[a-f0-9]{64}$/)
				.parse(digest);
			const result = await run(
				["tar", "-xOf", archive, `blobs/sha256/${digest.slice(7)}`],
				{ timeoutMs: 30000, maxBytes: 1024 * 1024 },
			);
			if (result.code !== 0 || result.signal)
				throw Error("Image archive blob read failed");
			return result.stdout;
		}
		const { verifySubject } = await import("./qualification-subject.ts");
		const binding = verifySubject({
			platform,
			manifestDigest: matches[0].digest,
			configDigest: manifest.config.digest,
			rawManifest: await readBlob(matches[0].digest),
			rawConfig: await readBlob(manifest.config.digest),
			container,
			image,
		});
		facts.subjectBinding = binding;
		expect(image.Config.Labels["org.opencontainers.image.revision"]).toBe(
			SOURCE,
		);
		expect(image.Config.Labels["io.klh.seed.recipe.revision"]).toBe(SOURCE);
		facts.configDigest = manifest.config.digest;
		facts.labels = image.Config.Labels;
		await driver.docker(["start", cid]);
		const origin = `http://127.0.0.1:${port}`;
		for (let attempt = 0; ; attempt++) {
			try {
				const readiness = await readHttp(
					`${origin}/status`,
					{},
					{ timeoutMs: 500 },
				);
				console.log(
					JSON.stringify({
						event: "readiness-status",
						path: "/status",
						status: readiness.status,
					}),
				);
				if (readiness.status === 200) break;
			} catch (error) {
				console.log(
					JSON.stringify({
						event: "readiness-refusal",
						path: "/status",
						message: String(error),
					}),
				);
			}
			if (attempt >= 39) throw Error("Service readiness deadline");
			await Bun.sleep(100);
		}
		facts.mode = mode;
		facts.api =
			mode === "main"
				? await qualifyApi(
						origin,
						data.rootKey,
						() =>
							data.stub.requests.filter(
								(request) => request.path === "/v1/chat/completions",
							).length,
						(fact) =>
							console.log(JSON.stringify({ event: "api-status", ...fact })),
					)
				: await qualifyNegative(origin, data.rootKey, mode, () =>
						mode === "neutral"
							? data.stub.requests.length
							: data.stub.requests.filter(
									(request) => request.path === "/v1/chat/completions",
								).length,
					);
		console.log(
			JSON.stringify({ event: "api-complete", mode, facts: facts.api }),
		);
		const state = await driver.docker([
			"exec",
			cid,
			"bun",
			"-e",
			"console.log(JSON.stringify({uid:process.getuid(),arch:process.arch,db:await Bun.file('/data/buckle.db').exists()}))",
		]);
		const runtime = z
			.object({
				uid: z.literal(1000),
				arch: z.literal(platform === "linux/amd64" ? "x64" : "arm64"),
				db: z.literal(true),
			})
			.parse(JSON.parse(state));
		facts.runtime = runtime;
		if (mode === "main")
			await driver.docker([
				"exec",
				cid,
				"bun",
				"/fleet/packages/suspenders/deploy/healthcheck/probe.ts",
				"--target",
				"http://127.0.0.1:4101/v1/models",
				"--catalog-model",
				"seed-model",
				"--auth-env",
				"BUCKLE_ROOT_KEY",
			]);
		if (mode === "main") facts.authenticatedProbeExit = 0;
		if (mode === "main") {
			const denied = await run(
				[
					"docker",
					"exec",
					"--env",
					"QUALIFICATION_BAD_KEY=invalid-synthetic-key",
					cid,
					"bun",
					"/fleet/packages/suspenders/deploy/healthcheck/probe.ts",
					"--target",
					"http://127.0.0.1:4101/v1/models",
					"--catalog-model",
					"seed-model",
					"--auth-env",
					"QUALIFICATION_BAD_KEY",
				],
				{ timeoutMs: 10000, maxBytes: 65536 },
			);
			if (denied.code !== 1 || denied.signal)
				throw Error("Unauthenticated probe did not fail as expected");
			facts.unauthorizedProbeExit = denied.code;
		}
	} catch (error) {
		// Response bodies and minted key material are never included in diagnostics.
		primaryFailure = Error(
			`Published qualification refused: ${String(error).replaceAll(data.rootKey, "[redacted]").replaceAll(data.upstreamKey, "[redacted]")}`,
		);
		console.log(
			JSON.stringify({
				event: "primary-refusal",
				message: primaryFailure.message,
			}),
		);
		throw primaryFailure;
	} finally {
		const { finishQualificationCleanup } = await import("./qualification.ts");
		await finishQualificationCleanup(primaryFailure, async () => {
			try {
				if (!cleaned && creationAttempted && ids.length === 0)
					ids.push(await driver.recoverCreated());
				if (!cleaned)
					for (const id of ids.filter((id) => !removed.includes(id))) {
						await driver.remove(id, mode !== "unkeyed");
						removed.push(id);
					}
				cleaned = true;
			} finally {
				data.stub.close();
				if (cleaned) data.world.clean();
			}
		});
	}
	return { ...facts, containerIds: ids, removedAndAbsent: removed };
}
