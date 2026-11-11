import { z } from "zod";

export const HOST_BUILD_PINS = {
	bun: "oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
	docker:
		"docker.io/library/docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d",
	dockerVersion: "29.9.3",
	dockerCommit: "5457199aa57c45e990c59c89cab5f02b817238d7",
	dockerSource: "https://api.github.com/repos/docker/cli/tarball/v29.9.3",
	dockerSourceSha256:
		"948a5572ecda216e97995657888ba3431a7068c8e1d27a7e7f70683d5b382c33",
} as const;
export const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
/** Compiler input audit; public SDK API code is distinct from private assets. */
export function runtimeInputKind(
	path: string,
): "runtime" | "sdk-evaluation-client" {
	const prefix =
		"node_modules/.bun/openai@7.19.0+c3b1d5d045878bb4/node_modules/openai/resources/evals/";
	const modules = [
		"evals.mjs",
		"index.mjs",
		"runs.mjs",
		"runs/index.mjs",
		"runs/output-items.mjs",
		"runs/runs.mjs",
	];
	if (path.startsWith(prefix) && modules.includes(path.slice(prefix.length)))
		return "sdk-evaluation-client";
	if (
		/(^|\/)(benchmarks?|datasets?|evals?|judges?|fixtures?|tests?)(\/|$)|(^|\/)packages\/blam\/|pi-coding-agent|pi-cli/.test(
			path,
		)
	)
		throw new Error(`Forbidden runtime input: ${path}`);
	return "runtime";
}
export const VersionSchema = z
	.string()
	.regex(/^\d+\.\d+\.\d+-experimental[.\w-]*$/);
export const PlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
export const SupervisorImageSchema = z
	.string()
	.regex(/^ghcr\.io\/klh\/fleet\/supervisor-seed@sha256:[a-f0-9]{64}$/);
/** EXACT existing Flock input: additional role metadata belongs in the envelope. */
export const FlockSupervisorInputSchema = z.strictObject({
	schemaVersion: z.literal(1),
	family: z.literal("supervisor"),
	version: VersionSchema,
	image: SupervisorImageSchema,
	sourceCommit: CommitSchema,
	architecture: z.enum(["amd64", "arm64"]),
});
const EvidenceSchema = z.enum(["verified", "not-inspected", "missing"]);
export const HostSupervisorDescriptorSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		family: z.literal("supervisor"),
		role: z.literal("host"),
		service: z.literal("runner-control"),
		version: VersionSchema,
		image: SupervisorImageSchema,
		sourceCommit: CommitSchema,
		recipeCommit: CommitSchema,
		architectures: z.array(z.enum(["amd64", "arm64"])).min(1),
		runtimeSmokePlatforms: z.array(PlatformSchema),
		producer: z.strictObject({
			name: z.literal("fleet"),
			repository: z.literal("https://github.com/klh/fleet"),
		}),
		build: z.strictObject({
			bunImage: z.literal(HOST_BUILD_PINS.bun),
			dockerCliImage: z.literal(HOST_BUILD_PINS.docker),
			tool: z.literal("docker-buildx"),
			provenance: EvidenceSchema,
			sbom: EvidenceSchema,
		}),
		continuity: EvidenceSchema,
		flockInputs: z.array(FlockSupervisorInputSchema).min(1),
	})
	.refine(
		(value) =>
			new Set(value.architectures).size === value.architectures.length &&
			value.runtimeSmokePlatforms.every((platform) =>
				value.architectures.some((arch) => platform === `linux/${arch}`),
			) &&
			value.flockInputs.length === value.architectures.length &&
			new Set(value.flockInputs.map((input) => input.architecture)).size ===
				value.architectures.length &&
			value.flockInputs.every(
				(input) =>
					value.architectures.includes(input.architecture) &&
					input.image === value.image &&
					input.sourceCommit === value.sourceCommit &&
					input.version === value.version,
			),
		"HOST descriptor and published platform inputs must agree",
	);
