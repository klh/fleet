import { z } from "zod";
export const BASE_IMAGE =
	"oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";
export const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const SeedVersionSchema = z
	.string()
	.regex(/^\d+\.\d+\.\d+-experimental[.\w-]*$/);
export const PlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
const EvidenceSchema = z.enum(["verified", "missing", "not-inspected"]);
export const ServiceSeedDescriptorV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		family: z.literal("service"),
		service: z.literal("buckle"),
		version: SeedVersionSchema,
		image: z
			.string()
			.regex(/^ghcr\.io\/klh\/fleet\/buckle-seed@sha256:[a-f0-9]{64}$/),
		sourceCommit: CommitSchema,
		recipeCommit: CommitSchema,
		architectures: z.array(z.enum(["amd64", "arm64"])).min(1),
		runtimeSmokePlatforms: z.array(PlatformSchema),
		producer: z.strictObject({
			name: z.literal("fleet"),
			repository: z.literal("https://github.com/klh/fleet"),
		}),
		build: z.strictObject({
			baseImage: z.string().regex(/@sha256:[a-f0-9]{64}$/),
			tool: z.literal("docker-buildx"),
			provenance: EvidenceSchema,
			sbom: EvidenceSchema,
		}),
	})
	.refine(
		(value) =>
			new Set(value.architectures).size === value.architectures.length &&
			value.runtimeSmokePlatforms.every((platform) =>
				value.architectures.some((arch) => platform === `linux/${arch}`),
			),
		"Runtime checks must refer to published architectures",
	);
