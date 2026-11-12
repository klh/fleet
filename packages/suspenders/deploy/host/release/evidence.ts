import { z } from "zod";
import {
	CommitSchema,
	PlatformSchema,
	VersionSchema,
	HOST_BUILD_PINS,
} from "../contract.ts";
import { DigestSchema, Sha256Schema, type Acceptance } from "./contract.ts";

const IdSchema = z.string().min(1).max(256);
const CidSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NegativeSchema = z.strictObject({
	refused: z.literal(true),
	modelEffects: z.literal(0),
	liveGuests: z.literal(0),
	liveKeys: z.literal(0),
	checkedCleanup: z.literal(true),
});
export const ContinuityEvidenceSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		sourceCommit: CommitSchema,
		recipeCommit: CommitSchema,
		version: VersionSchema,
		platform: PlatformSchema,
		configDigest: DigestSchema,
		testCommit: CommitSchema,
		testSourceAggregate: Sha256Schema,
		environment: z.literal("scripted-local-docker-desktop"),
		oldHostCid: CidSchema,
		newHostCid: CidSchema,
		oldGuestCid: CidSchema,
		newGuestCid: CidSchema,
		oldEpoch: z.number().int().positive(),
		newEpoch: z.number().int().positive(),
		oldKeyId: IdSchema,
		newKeyId: IdSchema,
		resumedModelKeyId: IdSchema,
		originalDeadline: z.iso.datetime(),
		resumedDeadline: z.iso.datetime(),
		oldKeyRevokedSequence: z.number().int().nonnegative(),
		newKeyIssuedSequence: z.number().int().positive(),
		postResumeToolCallId: IdSchema,
		workspaceMarkerSha256: Sha256Schema,
		resumedMarkerSha256: Sha256Schema,
		priorConversationSha256: Sha256Schema,
		resumedPriorConversationSha256: Sha256Schema,
		continuedConversationSha256: Sha256Schema,
		unauthorizedResume: NegativeSchema,
		corruptCheckpoint: NegativeSchema,
		missingJournal: NegativeSchema,
	})
	.superRefine((value, ctx) => {
		const issue = (message: string) =>
			ctx.addIssue({ code: "custom", message });
		if (
			value.oldHostCid === value.newHostCid ||
			value.oldGuestCid === value.newGuestCid
		)
			issue("Continuity must use new HOST and guest");
		if (
			value.newEpoch <= value.oldEpoch ||
			value.newKeyId === value.oldKeyId ||
			value.resumedModelKeyId !== value.newKeyId
		)
			issue("Fresh epoch/key/model header not proved");
		if (value.originalDeadline !== value.resumedDeadline)
			issue("Original deadline changed");
		if (value.oldKeyRevokedSequence >= value.newKeyIssuedSequence)
			issue("Old key overlaps fresh authority");
		if (
			value.workspaceMarkerSha256 !== value.resumedMarkerSha256 ||
			value.priorConversationSha256 !== value.resumedPriorConversationSha256 ||
			value.continuedConversationSha256 === value.priorConversationSha256
		)
			issue("Workspace or conversation continuity not proved");
	});
export const ClosureSchema = z.object({
	schemaVersion: z.literal(1),
	architecture: z.enum(["arm64", "x64"]),
	packages: z
		.array(z.object({ name: z.string().min(1), version: z.string().min(1) }))
		.min(1)
		.max(4096),
	dockerCli: z.object({
		image: z.literal(HOST_BUILD_PINS.docker),
		version: z.literal(HOST_BUILD_PINS.dockerVersion),
		sourceCommit: z.literal(HOST_BUILD_PINS.dockerCommit),
		binarySha256: Sha256Schema,
		bytes: z.number().int().positive(),
	}),
});
export type AcceptanceArtifact = {
	platform: string;
	closure: Uint8Array;
	report: Uint8Array;
};
export const hash = (bytes: Uint8Array) =>
	`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
export function parseJson(bytes: Uint8Array): unknown {
	if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024)
		throw new Error("Evidence JSON byte bound");
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function verifyArtifacts(
	receipt: Acceptance[number],
	artifacts: AcceptanceArtifact[],
) {
	const matches = artifacts.filter(
		(artifact) => artifact.platform === receipt.platform,
	);
	if (matches.length !== 1)
		throw new Error("Exactly one evidence artifact pair per platform required");
	const artifact = matches[0];
	if (
		hash(artifact.closure) !==
			`sha256:${receipt.subject.runtimeClosureSha256}` ||
		hash(artifact.report) !==
			`sha256:${receipt.verification.immutableReportSha256}`
	)
		throw new Error("Acceptance artifact bytes mismatch");
	const evidence = ContinuityEvidenceSchema.parse(parseJson(artifact.report));
	for (const key of [
		"sourceCommit",
		"recipeCommit",
		"version",
		"platform",
	] as const)
		if (evidence[key] !== receipt[key])
			throw new Error(`Evidence identity mismatch: ${key}`);
	if (
		evidence.configDigest !== receipt.subject.configDigest ||
		evidence.testCommit !== receipt.verification.testCommit ||
		evidence.testSourceAggregate !== receipt.verification.testSourceAggregate
	)
		throw new Error("Evidence tested subject/source mismatch");
	const closure = ClosureSchema.parse(parseJson(artifact.closure));
	const expectedArch = receipt.platform === "linux/amd64" ? "x64" : "arm64";
	if (closure.architecture !== expectedArch)
		throw new Error("Closure architecture mismatch");
	return closure;
}
