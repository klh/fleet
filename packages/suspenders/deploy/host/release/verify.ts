import type { ImageMetadata } from "./plan.ts";
import { verifyProvenance } from "./provenance.ts";
import { z } from "zod";
import {
	HostSupervisorDescriptorSchema,
	HOST_BUILD_PINS,
} from "../contract.ts";
import { DigestSchema, REPOSITORY } from "./contract.ts";
import { checkedAcceptance } from "./plan.ts";
import {
	hash,
	parseJson,
	verifyArtifacts,
	type AcceptanceArtifact,
} from "./evidence.ts";

const OCI = "application/vnd.oci.";
const DescriptorSchema = z.object({
	mediaType: z.string(),
	digest: DigestSchema,
	size: z
		.number()
		.int()
		.positive()
		.max(4 * 1024 * 1024 * 1024),
	annotations: z.record(z.string(), z.string()).optional(),
	platform: z
		.object({
			architecture: z.string(),
			os: z.string(),
			variant: z.string().optional(),
		})
		.optional(),
});
const ManifestSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.literal(`${OCI}image.manifest.v1+json`),
	config: DescriptorSchema,
	layers: z.array(DescriptorSchema).min(1).max(128),
});
const IndexSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.literal(`${OCI}image.index.v1+json`),
	manifests: z.array(DescriptorSchema).min(1).max(8),
});
const ConfigSchema = z.object({
	architecture: z.enum(["arm64", "amd64"]),
	os: z.literal("linux"),
	rootfs: z.object({
		type: z.literal("layers"),
		diff_ids: z.array(DigestSchema).min(1).max(128),
	}),
	config: z.object({
		User: z.literal("1000:1000"),
		Entrypoint: z.tuple([
			z.literal("bun"),
			z.literal("/opt/fleet/runner-control.js"),
		]),
		Labels: z.record(z.string(), z.string()),
	}),
});
const StatementSchema = z.object({
	_type: z.enum([
		"https://in-toto.io/Statement/v0.1",
		"https://in-toto.io/Statement/v1",
	]),
	subject: z
		.array(
			z.object({
				digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
			}),
		)
		.min(1)
		.max(8),
	predicateType: z.string(),
	predicate: z.unknown(),
});

const SpdxSchema = z.object({
	spdxVersion: z.literal("SPDX-2.3"),
	SPDXID: z.literal("SPDXRef-DOCUMENT"),
	packages: z
		.array(z.object({ name: z.string(), versionInfo: z.string().optional() }))
		.min(1)
		.max(16384),
});
export type BlobReader = (digest: string) => Promise<Uint8Array>;
/** Reads actual content-addressed bytes. A receipt is emitted only after the full chain verifies. */
export async function verifyPublication(
	rawRequest: unknown,
	rawAcceptance: unknown,
	imageMetadata: ImageMetadata,
	rawDigest: unknown,
	reader: BlobReader,
	artifacts: AcceptanceArtifact[],
	now = Date.now(),
) {
	const { request, acceptance } = checkedAcceptance(
		rawRequest,
		rawAcceptance,
		now,
	);
	const indexDigest = DigestSchema.parse(rawDigest);
	let total = 0;
	const cache = new Map<string, Uint8Array>();
	const read = async (digest: string, size?: number) => {
		DigestSchema.parse(digest);
		let bytes = cache.get(digest);
		if (!bytes) {
			bytes = await reader(digest);
			total += bytes.length;
			if (bytes.length > 8 * 1024 * 1024 || total > 32 * 1024 * 1024)
				throw new Error("Registry verification byte bound exceeded");
			if (hash(bytes) !== digest)
				throw new Error("Registry content digest mismatch");
			cache.set(digest, bytes);
		}
		if (size !== undefined && size !== bytes.length)
			throw new Error("OCI descriptor size mismatch");
		return parseJson(bytes);
	};
	const index = IndexSchema.parse(await read(indexDigest));
	const runtimes = index.manifests.filter(
		(manifest) => manifest.platform?.os === "linux",
	);
	const attestations = index.manifests.filter(
		(manifest) =>
			manifest.annotations?.["vnd.docker.reference.type"] ===
			"attestation-manifest",
	);
	if (
		runtimes.length !== request.platforms.length ||
		runtimes.length + attestations.length !== index.manifests.length
	)
		throw new Error("Unexpected index entries");
	const platforms = [];
	for (const platform of request.platforms) {
		const arch = platform.split("/")[1];
		const matches = runtimes.filter(
			(manifest) => manifest.platform?.architecture === arch,
		);
		if (matches.length !== 1 || matches[0].platform?.variant)
			throw new Error("Exact platform coverage required");
		const descriptor = matches[0];
		const manifest = ManifestSchema.parse(
			await read(descriptor.digest, descriptor.size),
		);
		const config = ConfigSchema.parse(
			await read(manifest.config.digest, manifest.config.size),
		);
		if (
			manifest.config.mediaType !== `${OCI}image.config.v1+json` ||
			config.architecture !== arch
		)
			throw new Error("OCI config architecture/media type mismatch");
		const receipt = acceptance.find((receipt) => receipt.platform === platform);
		if (!receipt) throw new Error("Missing platform acceptance");
		if (
			receipt.subject.configDigest !== manifest.config.digest ||
			receipt.subject.platformManifest !== descriptor.digest ||
			JSON.stringify(receipt.subject.rootFsDiffIds) !==
				JSON.stringify(config.rootfs.diff_ids)
		)
			throw new Error(
				"Tested OCI subject mismatch; test actual pulled digest before promotion",
			);
		if (config.rootfs.diff_ids.length !== manifest.layers.length)
			throw new Error("OCI layer count mismatch");
		const labels = {
			"org.opencontainers.image.created": imageMetadata.created,
			"org.opencontainers.image.title": "Fleet HOST supervisor",
			"org.opencontainers.image.description":
				"Fleet production runner-control HOST supervisor",
			"org.opencontainers.image.url":
				"https://github.com/klh/fleet/tree/main/packages/suspenders/deploy/host",
			"org.opencontainers.image.source": "https://github.com/klh/fleet",
			"org.opencontainers.image.revision": request.sourceCommit,
			"org.opencontainers.image.version": request.version,
			"io.klh.fleet.seed.family": "supervisor",
			"io.klh.fleet.supervisor.role": "host",
			"io.klh.fleet.supervisor.service": "runner-control",
			"io.klh.fleet.recipe.commit": request.recipeCommit,
			"io.klh.fleet.checkpoint.continuity": "unverified",
		};
		for (const [key, value] of Object.entries(labels))
			if (config.config.Labels[key] !== value)
				throw new Error(`Config label mismatch: ${key}`);
		const closure = verifyArtifacts(receipt, artifacts);
		const bound = attestations.filter(
			(attestation) =>
				attestation.annotations?.["vnd.docker.reference.digest"] ===
				descriptor.digest,
		);
		if (bound.length !== 1)
			throw new Error("Exactly one bound attestation manifest required");
		const attestation = ManifestSchema.parse(
			await read(bound[0].digest, bound[0].size),
		);
		let provenanceDigest: string | undefined;
		let sbomDigest: string | undefined;
		for (const layer of attestation.layers) {
			if (layer.mediaType !== "application/vnd.in-toto+json")
				throw new Error("Unknown attestation media type");
			const statement = StatementSchema.parse(
				await read(layer.digest, layer.size),
			);
			if (
				statement.subject.length !== 1 ||
				statement.subject[0].digest.sha256 !== descriptor.digest.slice(7)
			)
				throw new Error("Attestation subject mismatch");
			if (statement.predicateType === "https://slsa.dev/provenance/v1") {
				if (provenanceDigest) throw new Error("Duplicate provenance");
				verifyProvenance(statement.predicate, request, platform, imageMetadata);
				provenanceDigest = layer.digest;
			} else if (statement.predicateType === "https://spdx.dev/Document") {
				if (sbomDigest) throw new Error("Duplicate SPDX");
				const sbom = SpdxSchema.parse(statement.predicate);
				for (const pkg of closure.packages)
					if (
						!sbom.packages.some(
							(entry) =>
								entry.name === pkg.name && entry.versionInfo === pkg.version,
						)
					)
						throw new Error(`SPDX runtime package missing: ${pkg.name}`);
				sbomDigest = layer.digest;
			} else throw new Error("Unknown attestation predicate");
		}
		if (!provenanceDigest || !sbomDigest)
			throw new Error("Provenance and SPDX must both verify");
		platforms.push({
			platform,
			manifestDigest: descriptor.digest,
			configDigest: manifest.config.digest,
			layers: manifest.layers,
			rootFsDiffIds: config.rootfs.diff_ids,
			provenanceDigest,
			sbomDigest,
			runtimeClosureSha256: receipt.subject.runtimeClosureSha256,
			acceptance: receipt,
		});
	}
	if (attestations.length !== platforms.length)
		throw new Error("Unexpected attestation coverage");
	const image = `${REPOSITORY}@${indexDigest}`;
	const architectures = request.platforms.map((platform) =>
		platform === "linux/amd64" ? ("amd64" as const) : ("arm64" as const),
	);
	const descriptor = HostSupervisorDescriptorSchema.parse({
		schemaVersion: 1,
		family: "supervisor",
		role: "host",
		service: "runner-control",
		version: request.version,
		image,
		sourceCommit: request.sourceCommit,
		recipeCommit: request.recipeCommit,
		architectures,
		runtimeSmokePlatforms: request.platforms,
		producer: { name: "fleet", repository: "https://github.com/klh/fleet" },
		build: {
			bunImage: HOST_BUILD_PINS.bun,
			dockerCliImage: HOST_BUILD_PINS.docker,
			tool: "docker-buildx",
			provenance: "verified",
			sbom: "verified",
		},
		continuity: "verified",
		flockInputs: architectures.map((architecture) => ({
			schemaVersion: 1,
			family: "supervisor",
			version: request.version,
			image,
			sourceCommit: request.sourceCommit,
			architecture,
		})),
	});
	return {
		schemaVersion: 1,
		verifiedAt: new Date(now).toISOString(),
		imageMetadata: {
			...imageMetadata,
			derivation:
				"max(sourceCommit.committerEpoch,recipeCommit.committerEpoch)" as const,
		},
		requestSha256: hash(
			new TextEncoder().encode(JSON.stringify(request)),
		).slice(7),
		descriptor,
		platforms,
		signatures: { status: "not-inspected" as const },
		evidenceScope: "scripted-local-docker-desktop" as const,
	};
}
