import { type PublisherIdentity, PublisherIdentitySchema } from "./identity.ts";
import { uploadPreflight } from "./preflight.ts";
import { stageContext, type StageRunner } from "../build.ts";
import {
	releasePlan,
	registryPreflight,
	checkedAcceptance,
	type ImageMetadata,
} from "./plan.ts";
import { DigestSchema } from "./contract.ts";
import { hash, type AcceptanceArtifact, verifyArtifacts } from "./evidence.ts";
import { verifyPublication, type BlobReader } from "./verify.ts";

export interface ReleaseDriver {
	publisher(): Promise<PublisherIdentity>;
	imageMetadata(source: string, recipe: string): Promise<ImageMetadata>;
	metadata(): Promise<unknown>;
	resolve(tag: string): Promise<string | null>;
	read: BlobReader;
	build(argv: string[], cwd: string): Promise<void>;
	/** PUT exactly these verified index bytes; never reconstruct an index. */
	promote(tag: string, bytes: Uint8Array): Promise<void>;
	stage(
		source: string,
		recipe: string,
	): Promise<{
		context: string;
		clean(): Promise<void>;
		recipeFiles: { path: string; gitPath: string; sha256: string }[];
	}>;
}
export function candidateTag(
	rawRequest: unknown,
	rawAcceptance: unknown,
	imageMetadata: ImageMetadata,
	now = Date.now(),
) {
	return releasePlan(rawRequest, rawAcceptance, imageMetadata, now).candidate;
}
function validateArtifacts(
	plan: Pick<ReturnType<typeof releasePlan>, "platforms" | "acceptance">,
	artifacts: AcceptanceArtifact[],
) {
	if (artifacts.length !== plan.platforms.length)
		throw new Error("Artifact coverage mismatch");
	for (const receipt of plan.acceptance) verifyArtifacts(receipt, artifacts);
}
/** Explicit execution entry point. Caller authorization is external to this module. */
export async function publishCandidate(
	rawRequest: unknown,
	rawAcceptance: unknown,
	artifacts: AcceptanceArtifact[],
	driver: ReleaseDriver,
	now = Date.now(),
) {
	const started = performance.now();
	const clock = () => now + Math.max(0, performance.now() - started);
	const checked = checkedAcceptance(rawRequest, rawAcceptance, clock());
	validateArtifacts(
		{ ...checked.request, acceptance: checked.acceptance },
		artifacts,
	);
	const imageMetadata = await driver.imageMetadata(
		checked.request.sourceCommit,
		checked.request.recipeCommit,
	);
	const plan = releasePlan(rawRequest, rawAcceptance, imageMetadata, clock());
	const publisher = PublisherIdentitySchema.parse(await driver.publisher());
	const beforeStage = uploadPreflight(await driver.metadata());
	const candidate = candidateTag(rawRequest, rawAcceptance, imageMetadata, now);
	if (await driver.resolve(plan.tag))
		throw Error("Immutable release tag already exists");
	if (await driver.resolve(candidate))
		throw Error("Immutable candidate tag already exists");
	const staged = await driver.stage(plan.sourceCommit, plan.recipeCommit);
	try {
		const argv = [...plan.argv];
		argv[argv.indexOf("--tag") + 1] = candidate;
		releasePlan(rawRequest, rawAcceptance, imageMetadata, clock());
		const beforeUpload = uploadPreflight(await driver.metadata());
		if (beforeStage.state === "present" && beforeUpload.state === "bootstrap")
			throw Error("Existing package disappeared before upload");
		if ((await driver.resolve(plan.tag)) || (await driver.resolve(candidate)))
			throw Error("Immutable tag appeared before build");
		await driver.publisher();
		await driver.build(argv, staged.context);
		const digest = DigestSchema.parse(await driver.resolve(candidate));
		const verification = await verifyPublication(
			rawRequest,
			rawAcceptance,
			imageMetadata,
			digest,
			driver.read,
			artifacts,
			clock(),
		);
		const afterUpload = registryPreflight(await driver.metadata());
		return {
			publication: "private-candidate" as const,
			publisher,
			stagedRecipeFiles: staged.recipeFiles,
			registry: { beforeUpload, afterUpload },
			candidate,
			digest,
			verification,
		};
	} finally {
		await staged.clean();
	}
}
export async function promoteCandidate(
	rawRequest: unknown,
	rawAcceptance: unknown,
	rawDigest: unknown,
	artifacts: AcceptanceArtifact[],
	driver: ReleaseDriver,
	now = Date.now(),
) {
	const started = performance.now();
	const clock = () => now + Math.max(0, performance.now() - started);
	const checked = checkedAcceptance(rawRequest, rawAcceptance, clock());
	validateArtifacts(
		{ ...checked.request, acceptance: checked.acceptance },
		artifacts,
	);
	const imageMetadata = await driver.imageMetadata(
		checked.request.sourceCommit,
		checked.request.recipeCommit,
	);
	const plan = releasePlan(rawRequest, rawAcceptance, imageMetadata, clock());
	const publisher = PublisherIdentitySchema.parse(await driver.publisher());
	const digest = DigestSchema.parse(rawDigest);
	registryPreflight(await driver.metadata());
	if (await driver.resolve(plan.tag))
		throw new Error("Immutable release tag already exists");
	const candidate = candidateTag(rawRequest, rawAcceptance, imageMetadata, now);
	if ((await driver.resolve(candidate)) !== digest)
		throw new Error("Candidate tag/digest mismatch");
	await verifyPublication(
		rawRequest,
		rawAcceptance,
		imageMetadata,
		digest,
		driver.read,
		artifacts,
		clock(),
	);
	const bytes = await driver.read(digest);
	if (hash(bytes) !== digest) throw new Error("Promotion index bytes changed");
	// Recheck at mutation boundary. GHCR has no atomic create-only tag operation.
	registryPreflight(await driver.metadata());
	if (await driver.resolve(plan.tag))
		throw new Error("Immutable release tag appeared before promotion");
	if ((await driver.resolve(candidate)) !== digest)
		throw new Error("Candidate moved before promotion");
	releasePlan(rawRequest, rawAcceptance, imageMetadata, clock());
	await driver.publisher();
	await driver.promote(plan.tag, bytes);
	if ((await driver.resolve(plan.tag)) !== digest)
		throw new Error("Promoted digest mismatch");
	const verification = await verifyPublication(
		rawRequest,
		rawAcceptance,
		imageMetadata,
		digest,
		driver.read,
		artifacts,
		clock(),
	);
	registryPreflight(await driver.metadata());
	return {
		publication: "published" as const,
		publisher,
		candidate,
		...verification,
	};
}
export function producerStage(repository: string, run?: StageRunner) {
	return (source: string, recipe: string) =>
		stageContext(source, recipe, repository, { run });
}
