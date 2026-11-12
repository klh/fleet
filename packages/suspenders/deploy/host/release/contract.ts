import { z } from "zod";
import { CommitSchema, PlatformSchema, VersionSchema } from "../contract.ts";

export const ReleaseVersionSchema = VersionSchema.max(100).refine(
	(value) =>
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-experimental(?:\.[0-9A-Za-z-]+)*$/.test(
			value,
		) &&
		value
			.slice(value.indexOf("-") + 1)
			.split(".")
			.every((part) => !/^0[0-9]+$/.test(part)),
	"Canonical experimental semantic version required",
);
export const REPOSITORY = "ghcr.io/klh/fleet/supervisor-seed";
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PlatformsSchema = z
	.array(PlatformSchema)
	.min(1)
	.max(2)
	.refine(
		(value) => new Set(value).size === value.length,
		"Duplicate platforms",
	);
export const ReleaseRequestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	sourceCommit: CommitSchema,
	recipeCommit: CommitSchema,
	version: ReleaseVersionSchema,
	platforms: PlatformsSchema,
});
export const ContinuityChecksSchema = z.strictObject({
	productionEntrypoint: z.literal(true),
	park: z.literal(true),
	newHost: z.literal(true),
	newGuest: z.literal(true),
	explicitResume: z.literal(true),
	workspaceMarker: z.literal(true),
	priorJournalContent: z.literal(true),
	continuedConversation: z.literal(true),
	freshEpoch: z.literal(true),
	oldKeyDeadBeforeNewKey: z.literal(true),
	freshModelHeader: z.literal(true),
	originalDeadline: z.literal(true),
	guestBoundary: z.literal(true),
	checkedCleanup: z.literal(true),
	corruptArchiveRefused: z.literal(true),
	missingJournalRefused: z.literal(true),
	unauthorizedResumeRefused: z.literal(true),
});
export const ContinuityReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("fleet-host-packaged-continuity"),
	sourceCommit: CommitSchema,
	recipeCommit: CommitSchema,
	version: ReleaseVersionSchema,
	platform: PlatformSchema,
	completedAt: z.iso.datetime(),
	subject: z.strictObject({
		localIndex: DigestSchema,
		platformManifest: DigestSchema,
		configDigest: DigestSchema,
		rootFsDiffIds: z.array(DigestSchema).min(1).max(128),
		runtimeClosureSha256: Sha256Schema,
	}),
	verification: z.strictObject({
		testCommit: CommitSchema,
		testSourceAggregate: Sha256Schema,
		immutableReportSha256: Sha256Schema,
		command: z.string().min(1).max(4096),
		outcome: z.literal("pass"),
		failed: z.literal(0),
		skipped: z.literal(0),
	}),
	controls: ContinuityChecksSchema,
});
export const AcceptanceSchema = z
	.array(ContinuityReceiptSchema)
	.min(1)
	.max(2)
	.refine(
		(value) =>
			new Set(value.map((receipt) => receipt.platform)).size === value.length,
		"Duplicate acceptance platform",
	);
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;
export type Acceptance = z.infer<typeof AcceptanceSchema>;
export const RegistryMetadataSchema = z.object({
	name: z.literal("fleet/supervisor-seed"),
	package_type: z.literal("container"),
	visibility: z.literal("private"),
	repository: z.object({
		full_name: z.literal("klh/fleet"),
		private: z.boolean().optional(),
	}),
});
