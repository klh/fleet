import type { ImageMetadata } from "./plan.ts";
import { z } from "zod";
import { HOST_BUILD_PINS, PI_NOTICE } from "../contract.ts";
import type { ReleaseRequest } from "./contract.ts";

const DefinitionSchema = z.object({
	buildDefinition: z.object({
		buildType: z.literal(
			"https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
		),
		externalParameters: z.object({
			request: z.object({ args: z.record(z.string(), z.unknown()) }),
		}),
		resolvedDependencies: z
			.array(
				z.object({
					uri: z.string(),
					digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
				}),
			)
			.min(1)
			.max(512),
	}),
});
/** Match actual BuildKit SLSA v1, not the legacy buildx metadata summary. */
export function verifyProvenance(
	predicate: unknown,
	request: ReleaseRequest,
	platform: string,
	imageMetadata: ImageMetadata,
) {
	const definition = DefinitionSchema.parse(predicate).buildDefinition;
	const args = definition.externalParameters.request.args;
	if (
		args["build-arg:SOURCE_COMMIT"] !== request.sourceCommit ||
		args["build-arg:RECIPE_COMMIT"] !== request.recipeCommit ||
		args["build-arg:VERSION"] !== request.version ||
		args["build-arg:CREATED"] !== imageMetadata.created
	)
		throw new Error("Provenance build identity mismatch");
	for (const [image, path] of [
		[HOST_BUILD_PINS.bun, "docker/oven/bun@1.4.4-slim"],
		[HOST_BUILD_PINS.docker, "docker/docker@29.9.3-cli"],
	]) {
		const digest = image.split("@sha256:")[1];
		if (
			!definition.resolvedDependencies.some((dependency) => {
				if (dependency.digest.sha256 !== digest) return false;
				const uri = new URL(dependency.uri);
				return (
					uri.protocol === "pkg:" &&
					uri.pathname === path &&
					uri.searchParams.get("digest") === `sha256:${digest}` &&
					uri.searchParams.get("platform") === platform &&
					[...uri.searchParams.keys()].sort().join(",") === "digest,platform"
				);
			})
		)
			throw new Error("Provenance exact base pin missing");
	}
	for (const [uri, digest] of [
		[HOST_BUILD_PINS.dockerSource, HOST_BUILD_PINS.dockerSourceSha256],
		[PI_NOTICE.url, PI_NOTICE.sha256],
	])
		if (
			!definition.resolvedDependencies.some(
				(dependency) =>
					dependency.uri === uri && dependency.digest.sha256 === digest,
			)
		)
			throw new Error("Provenance source notice pin missing");
}
