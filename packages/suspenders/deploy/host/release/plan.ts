import type { imageCreated } from "../build.ts";
export type ImageMetadata = Awaited<ReturnType<typeof imageCreated>>;
import { hash } from "./evidence.ts";
import {
	AcceptanceSchema,
	RegistryMetadataSchema,
	ReleaseRequestSchema,
	REPOSITORY,
} from "./contract.ts";

export const ACCEPTANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function checkedAcceptance(
	rawRequest: unknown,
	rawAcceptance: unknown,
	now = Date.now(),
) {
	const request = ReleaseRequestSchema.parse(rawRequest);
	const acceptance = AcceptanceSchema.parse(rawAcceptance);
	for (const receipt of acceptance) {
		const age = now - Date.parse(receipt.completedAt);
		if (!Number.isFinite(now) || age < 0 || age > ACCEPTANCE_MAX_AGE_MS)
			throw new Error("Acceptance is stale or future-dated");
		for (const key of ["sourceCommit", "recipeCommit", "version"] as const)
			if (request[key] !== receipt[key])
				throw new Error(`Acceptance identity mismatch: ${key}`);
	}
	if (
		request.platforms.length !== acceptance.length ||
		request.platforms.some(
			(platform) =>
				!acceptance.some((receipt) => receipt.platform === platform),
		)
	)
		throw new Error("Acceptance platform mismatch");
	return { request, acceptance };
}
export function acceptanceFor(
	rawRequest: unknown,
	rawAcceptance: unknown,
	platform: string,
	now = Date.now(),
) {
	const { acceptance } = checkedAcceptance(rawRequest, rawAcceptance, now);
	const result = acceptance.find((result) => result.platform === platform);
	if (!result) throw new Error("No exact platform acceptance");
	return result;
}
export function registryPreflight(raw: unknown) {
	return RegistryMetadataSchema.parse(raw);
}
/** A reviewable command plan only. Nothing in this module uploads payloads. */
export function releasePlan(
	rawRequest: unknown,
	rawAcceptance: unknown,
	imageMetadata: ImageMetadata,
	now = Date.now(),
) {
	if (!imageMetadata || typeof imageMetadata.created !== "string")
		throw Error("Derived immutable image metadata required");
	const { request, acceptance } = checkedAcceptance(
		rawRequest,
		rawAcceptance,
		now,
	);
	const tag = `${REPOSITORY}:${request.version}`;
	const requestSha256 = hash(
		new TextEncoder().encode(JSON.stringify(request)),
	).slice(7);
	const candidate = `${tag}-candidate-${requestSha256.slice(0, 12)}`;
	return {
		...request,
		publication: "not-published" as const,
		tag,
		candidate,
		requestSha256,
		acceptance,
		imageMetadata: {
			...imageMetadata,
			derivation:
				"max(sourceCommit.committerEpoch,recipeCommit.committerEpoch)" as const,
		},
		argv: [
			"docker",
			"buildx",
			"build",
			"--platform",
			request.platforms.join(","),
			"--tag",
			candidate,
			"--build-arg",
			`SOURCE_COMMIT=${request.sourceCommit}`,
			"--build-arg",
			`RECIPE_COMMIT=${request.recipeCommit}`,
			"--build-arg",
			`VERSION=${request.version}`,
			"--build-arg",
			`CREATED=${imageMetadata.created}`,
			"--provenance=mode=max",
			"--sbom=true",
			"--metadata-file",
			"publication-metadata.json",
			"--push",
			".",
		],
	};
}
