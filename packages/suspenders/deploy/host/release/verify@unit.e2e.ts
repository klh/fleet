import { imageMetadata } from "./test-fixture.ts";
import { expect, test } from "@playwright/test";
import { verifyPublication } from "./verify.ts";
import { fixture, request, now, encode, digest } from "./test-fixture.ts";
import { FlockSupervisorInputSchema } from "../contract.ts";

test("verifies exact registry bytes/attestations and emits six-field projections, signatures unverified @unit", async () => {
	const f = fixture();
	const result = await verifyPublication(
		request,
		f.acceptance,
		imageMetadata,
		f.index.digest,
		f.reader,
		f.artifacts,
		now,
	);
	expect(result.descriptor.continuity).toBe("verified");
	expect(result.signatures).toEqual({ status: "not-inspected" });
	const projection = result.descriptor.flockInputs[0];
	expect(Object.keys(projection)).toHaveLength(6);
	expect(FlockSupervisorInputSchema.parse(projection)).toEqual(projection);
	expect(result.platforms[0].configDigest).toBe(f.config.digest);
});
test("config drift, corrupt bytes, missing evidence and forged subject refuse @unit", async () => {
	for (const mutate of [
		(f: ReturnType<typeof fixture>) => {
			f.acceptance[0].subject.configDigest = `sha256:${"1".repeat(64)}`;
		},
		(f: ReturnType<typeof fixture>) => {
			f.blobs.set(f.config.digest, new TextEncoder().encode("{}"));
		},
		(f: ReturnType<typeof fixture>) => {
			f.blobs.delete(f.provenance.digest);
		},
		(f: ReturnType<typeof fixture>) => {
			f.artifacts[0].report = new Uint8Array();
		},
		(f: ReturnType<typeof fixture>) => {
			f.artifacts[0].closure = new Uint8Array();
		},
	]) {
		const f = fixture();
		mutate(f);
		await expect(
			verifyPublication(
				request,
				f.acceptance,
				imageMetadata,
				f.index.digest,
				f.reader,
				f.artifacts,
				now,
			),
		).rejects.toThrow();
	}
});

test("content-addressed but semantically wrong attestations/labels/auditable facts refuse @unit", async () => {
	for (const options of [
		{ provenanceSource: "f".repeat(40) },
		{ subjectDigest: "f".repeat(64) },
		{ sbomVersion: "0.0.0" },
		{ configSource: "f".repeat(40) },
		{ report: { oldKeyRevokedSequence: 8 } },
		{ report: { resumedPriorConversationSha256: "9".repeat(64) } },
		{ report: { newGuestCid: "3".repeat(64) } },
		{ report: { resumedDeadline: "2026-11-13T13:00:00Z" } },
		{
			report: {
				unauthorizedResume: {
					refused: true,
					modelEffects: 1,
					liveGuests: 0,
					liveKeys: 0,
					checkedCleanup: true,
				},
			},
		},
	]) {
		const f = fixture(options);
		await expect(
			verifyPublication(
				request,
				f.acceptance,
				imageMetadata,
				f.index.digest,
				f.reader,
				f.artifacts,
				now,
			),
		).rejects.toThrow();
	}
});

test("both requested architectures require distinct exact config-bound acceptance and six-field projections @unit", async () => {
	const arm = fixture();
	const amd = fixture({ platform: "linux/amd64" });
	const readIndex = (f: ReturnType<typeof fixture>) =>
		JSON.parse(new TextDecoder().decode(f.blobs.get(f.index.digest))).manifests;
	const bytes = encode({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [...readIndex(arm), ...readIndex(amd)],
	});
	const index = digest(bytes);
	const blobs = new Map([...arm.blobs, ...amd.blobs, [index, bytes]]);
	const req = { ...request, platforms: ["linux/arm64", "linux/amd64"] };
	const acceptance = [...arm.acceptance, ...amd.acceptance];
	const artifacts = [...arm.artifacts, ...amd.artifacts];
	const reader = async (hash: string) => {
		const bytes = blobs.get(hash);
		if (!bytes) throw Error("Missing fixture");
		return bytes;
	};
	const result = await verifyPublication(
		req,
		acceptance,
		imageMetadata,
		index,
		reader,
		artifacts,
		now,
	);
	expect(result.descriptor.architectures).toEqual(["arm64", "amd64"]);
	expect(
		result.descriptor.flockInputs.map((input) => Object.keys(input).length),
	).toEqual([6, 6]);
	expect(result.platforms[0].configDigest).not.toBe(
		result.platforms[1].configDigest,
	);
	await expect(
		verifyPublication(
			req,
			arm.acceptance,
			imageMetadata,
			index,
			reader,
			artifacts,
			now,
		),
	).rejects.toThrow();
});

test("created label and provenance must match derived metadata while BuildKit config.Created may differ @unit", async () => {
	const f = fixture();
	const result = await verifyPublication(
		request,
		f.acceptance,
		imageMetadata,
		f.index.digest,
		f.reader,
		f.artifacts,
		now,
	);
	expect(result.imageMetadata.created).toBe(imageMetadata.created);
	const config = JSON.parse(
		new TextDecoder().decode(f.blobs.get(f.config.digest)),
	);
	expect(config.created).toBe("2020-01-01T00:00:00.000Z");
	expect(config.created).not.toBe(imageMetadata.created);
	for (const options of [
		{ configCreated: "2026-01-01T00:00:00.000Z" },
		{ provenanceCreated: "2026-01-01T00:00:00.000Z" },
		{ configTitle: "Bun inherited title" },
	]) {
		const wrong = fixture(options);
		await expect(
			verifyPublication(
				request,
				wrong.acceptance,
				imageMetadata,
				wrong.index.digest,
				wrong.reader,
				wrong.artifacts,
				now,
			),
		).rejects.toThrow();
	}
});
