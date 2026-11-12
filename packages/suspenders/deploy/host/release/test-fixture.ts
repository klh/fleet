import { HOST_BUILD_PINS } from "../contract.ts";
export const digest = (bytes: Uint8Array) =>
	`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
export const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
export const now = Date.parse("2026-11-12T12:00:00Z");
export const imageMetadata = {
	created: "2023-11-14T22:15:23.000Z",
	epochSeconds: 1700000123,
	sourceEpochSeconds: 1700000000,
	recipeEpochSeconds: 1700000123,
};
export const request = {
	schemaVersion: 1 as const,
	sourceCommit: "a".repeat(40),
	recipeCommit: "b".repeat(40),
	version: "0.1.2-experimental.w29904",
	platforms: ["linux/arm64"],
};
export function fixture(
	options: {
		platform?: "linux/arm64" | "linux/amd64";
		provenanceSource?: string;
		subjectDigest?: string;
		sbomVersion?: string;
		configSource?: string;
		configCreated?: string;
		provenanceCreated?: string;
		configTitle?: string;
		report?: Record<string, unknown>;
	} = {},
) {
	const platformName = options.platform ?? "linux/arm64";
	const arch = platformName === "linux/amd64" ? "amd64" : "arm64";
	const blobs = new Map<string, Uint8Array>();
	const put = (value: unknown) => {
		const bytes = encode(value);
		const hash = digest(bytes);
		blobs.set(hash, bytes);
		return {
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			digest: hash,
			size: bytes.length,
		};
	};
	const negative = {
		refused: true,
		modelEffects: 0,
		liveGuests: 0,
		liveKeys: 0,
		checkedCleanup: true,
	};
	const reportFacts = {
		schemaVersion: 1,
		environment: "scripted-local-docker-desktop",
		oldHostCid: "1".repeat(64),
		newHostCid: "2".repeat(64),
		oldGuestCid: "3".repeat(64),
		newGuestCid: "4".repeat(64),
		oldEpoch: 1,
		newEpoch: 3,
		oldKeyId: "key-1",
		newKeyId: "key-3",
		resumedModelKeyId: "key-3",
		originalDeadline: "2026-11-12T13:00:00Z",
		resumedDeadline: "2026-11-12T13:00:00Z",
		oldKeyRevokedSequence: 4,
		newKeyIssuedSequence: 7,
		postResumeToolCallId: "tool-after-resume",
		workspaceMarkerSha256: "5".repeat(64),
		resumedMarkerSha256: "5".repeat(64),
		priorConversationSha256: "6".repeat(64),
		resumedPriorConversationSha256: "6".repeat(64),
		continuedConversationSha256: "7".repeat(64),
		unauthorizedResume: negative,
		corruptCheckpoint: negative,
		missingJournal: negative,
		...options.report,
	};
	const closure = encode({
		schemaVersion: 1,
		architecture: arch === "amd64" ? "x64" : "arm64",
		packages: [{ name: "zod", version: "4.4.0" }],
		dockerCli: {
			image: HOST_BUILD_PINS.docker,
			version: HOST_BUILD_PINS.dockerVersion,
			sourceCommit: HOST_BUILD_PINS.dockerCommit,
			binarySha256: "d".repeat(64),
			bytes: 120,
		},
	});
	const config = put({
		architecture: arch,
		created: "2020-01-01T00:00:00.000Z",
		os: "linux",
		rootfs: { type: "layers", diff_ids: [`sha256:${"f".repeat(64)}`] },
		config: {
			User: "1000:1000",
			Entrypoint: ["bun", "/opt/fleet/runner-control.js"],
			Labels: {
				"org.opencontainers.image.title":
					options.configTitle ?? "Fleet HOST supervisor",
				"org.opencontainers.image.description":
					"Fleet production runner-control HOST supervisor",
				"org.opencontainers.image.url":
					"https://github.com/klh/fleet/tree/main/packages/suspenders/deploy/host",
				"org.opencontainers.image.created":
					options.configCreated ?? imageMetadata.created,
				"org.opencontainers.image.source": "https://github.com/klh/fleet",
				"org.opencontainers.image.revision":
					options.configSource ?? request.sourceCommit,
				"org.opencontainers.image.version": request.version,
				"io.klh.fleet.seed.family": "supervisor",
				"io.klh.fleet.supervisor.role": "host",
				"io.klh.fleet.supervisor.service": "runner-control",
				"io.klh.fleet.recipe.commit": request.recipeCommit,
				"io.klh.fleet.checkpoint.continuity": "unverified",
			},
		},
	});
	config.mediaType = "application/vnd.oci.image.config.v1+json";
	const platform = put({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config,
		layers: [
			{
				mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
				digest: `sha256:${"e".repeat(64)}`,
				size: 100 * 1024 * 1024,
			},
		],
	});
	const subject = [
		{
			name: "fixture",
			digest: { sha256: options.subjectDigest ?? platform.digest.slice(7) },
		},
	];
	const provenance = put({
		_type: "https://in-toto.io/Statement/v1",
		subject,
		predicateType: "https://slsa.dev/provenance/v1",
		predicate: {
			buildDefinition: {
				buildType:
					"https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
				externalParameters: {
					request: {
						args: {
							"build-arg:SOURCE_COMMIT":
								options.provenanceSource ?? request.sourceCommit,
							"build-arg:RECIPE_COMMIT": request.recipeCommit,
							"build-arg:VERSION": request.version,
							"build-arg:CREATED":
								options.provenanceCreated ?? imageMetadata.created,
						},
					},
				},
				resolvedDependencies: [
					...[
						["docker/oven/bun@1.4.4-slim", HOST_BUILD_PINS.bun],
						["docker/docker@29.9.3-cli", HOST_BUILD_PINS.docker],
					].map(([path, image]) => ({
						uri:
							"pkg:" +
							path +
							"?digest=sha256:" +
							image.split("@sha256:")[1] +
							"&platform=" +
							encodeURIComponent(platformName),
						digest: { sha256: image.split("@sha256:")[1] },
					})),
					{
						uri: HOST_BUILD_PINS.dockerSource,
						digest: { sha256: HOST_BUILD_PINS.dockerSourceSha256 },
					},
					{
						uri: "https://raw.githubusercontent.com/earendil-works/pi/f9a26365568127461c47a07a37dcb42c140a3ac5/LICENSE",
						digest: {
							sha256:
								"0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48",
						},
					},
				],
			},
		},
	});
	const sbom = put({
		_type: "https://in-toto.io/Statement/v0.1",
		subject,
		predicateType: "https://spdx.dev/Document",
		predicate: {
			spdxVersion: "SPDX-2.3",
			SPDXID: "SPDXRef-DOCUMENT",
			packages: [{ name: "zod", versionInfo: options.sbomVersion ?? "4.4.0" }],
		},
	});
	provenance.mediaType = sbom.mediaType = "application/vnd.in-toto+json";
	const attestation = put({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config,
		layers: [provenance, sbom],
	});
	const index = put({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			{ ...platform, platform: { os: "linux", architecture: arch } },
			{
				...attestation,
				platform: { os: "unknown", architecture: "unknown" },
				annotations: {
					"vnd.docker.reference.type": "attestation-manifest",
					"vnd.docker.reference.digest": platform.digest,
				},
			},
		],
	});
	const report = encode({
		...reportFacts,
		sourceCommit: request.sourceCommit,
		recipeCommit: request.recipeCommit,
		version: request.version,
		platform: platformName,
		configDigest: config.digest,
		testCommit: request.sourceCommit,
		testSourceAggregate: "b".repeat(64),
	});
	const acceptance = [
		{
			schemaVersion: 1,
			kind: "fleet-host-packaged-continuity",
			sourceCommit: request.sourceCommit,
			recipeCommit: request.recipeCommit,
			version: request.version,
			platform: platformName,
			completedAt: "2026-11-12T11:00:00Z",
			subject: {
				localIndex: index.digest,
				platformManifest: platform.digest,
				configDigest: config.digest,
				rootFsDiffIds: [`sha256:${"f".repeat(64)}`],
				runtimeClosureSha256: digest(closure).slice(7),
			},
			verification: {
				testCommit: "a".repeat(40),
				testSourceAggregate: "b".repeat(64),
				immutableReportSha256: digest(report).slice(7),
				command: "bun playwright test packaged-continuity",
				outcome: "pass",
				failed: 0,
				skipped: 0,
			},
			controls: {
				productionEntrypoint: true,
				park: true,
				newHost: true,
				newGuest: true,
				explicitResume: true,
				workspaceMarker: true,
				priorJournalContent: true,
				continuedConversation: true,
				freshEpoch: true,
				oldKeyDeadBeforeNewKey: true,
				freshModelHeader: true,
				originalDeadline: true,
				guestBoundary: true,
				checkedCleanup: true,
				corruptArchiveRefused: true,
				missingJournalRefused: true,
				unauthorizedResumeRefused: true,
			},
		},
	];
	return {
		blobs,
		index,
		platform,
		config,
		provenance,
		sbom,
		acceptance,
		closure,
		report,
		artifacts: [{ platform: platformName, closure, report }],
		reader: async (hash: string) => {
			const bytes = blobs.get(hash);
			if (!bytes) throw new Error("Missing blob");
			return bytes;
		},
	};
}
