// src/seed-manifest.ts — W2958: the reproducible Pi Durable seed manifest.
// ONE canonical core shared by the seed build (seed/build.ts), the in-image
// readiness probe (src/seed-readiness.ts) and the tests. Two byte-compatible
// contracts with the runner host (packages/suspenders
// hooks/lib/runners/desktop/seed.ts + docker-executor.ts, W2869.3):
//   - canonicalSeedDigest — sha256 over canonical JSON of path-sorted
//     {path, digest} pairs (no order noise, no newline aliasing, root
//     #117936); the host recomputes this at admit and refuses drift.
//   - canonicalPolicyDigest — sha256 over the canonical limits JSON in the
//     executor's exact key order; start refuses a spec stamped with a
//     different digest.
// Both algorithms are pinned here by test vectors computed FROM the host
// implementations (test/seed@unit.e2e.ts) — a divergence fails the suite
// before a seed image can drift from its host contract.
import { createHash } from "node:crypto";
import { z } from "zod";

/** sha256 hex — the same primitive the runner host's digestOf uses. */
export const digestOf = (input: string | Uint8Array): string =>
	createHash("sha256").update(input).digest("hex");

export interface SeedFile {
	path: string;
	bytes: Uint8Array;
}

/** Canonical seed digest over a payload file set (payload-relative paths). */
export const canonicalSeedDigest = (files: readonly SeedFile[]): string => {
	const entries = files
		.map((f) => ({ path: f.path, digest: digestOf(f.bytes) }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return digestOf(JSON.stringify(entries));
};

/** The policy shape the desktop executor digests (its exact field order). */
export interface SeedPolicy {
	image: string;
	network: "none";
	readOnlyRoot: true;
	capDropAll: true;
	noNewPrivileges: true;
	user: string;
	memoryMb: number;
	cpus: number;
	pidsLimit: number;
	workMb: number;
	tmpMb: number;
}

/** Canonical JSON in the executor's key order — insertion order is the
 *  contract; do not alphabetize. */
export const canonicalPolicyJson = (policy: SeedPolicy): string =>
	JSON.stringify({
		image: policy.image,
		network: policy.network,
		readOnlyRoot: policy.readOnlyRoot,
		capDropAll: policy.capDropAll,
		noNewPrivileges: policy.noNewPrivileges,
		user: policy.user,
		memoryMb: policy.memoryMb,
		cpus: policy.cpus,
		pidsLimit: policy.pidsLimit,
		workMb: policy.workMb,
		tmpMb: policy.tmpMb,
	});

export const canonicalPolicyDigest = (policy: SeedPolicy): string =>
	digestOf(canonicalPolicyJson(policy));

// — manifest shape (schema law: named schema, safeParse at the face) —

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ImagePin = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);

export const SeedManifestSchema = z.strictObject({
	schema_version: z.literal(1),
	kind: z.literal("pi-durable-seed"),
	name: z.literal("klh/pi-durable-seed"),
	version: z.string().min(1),
	source: z.strictObject({
		revision: z.string().regex(/^[0-9a-f]{40,64}$/),
		dirty: z.boolean(),
		package: z.literal("@klh/pi-durable-workers"),
	}),
	base_image: ImagePin,
	runtime_image: ImagePin,
	platform: z.literal("linux/amd64"),
	seed: z.strictObject({
		digest: Digest,
		files: z.number().int().positive(),
		bytes: z.number().int().positive(),
	}),
	policy: z.strictObject({
		digest: Digest,
		user: z.string().regex(/^\d+:\d+$/),
		memory_mb: z.number().int().positive(),
		cpus: z.number().positive(),
		pids_limit: z.number().int().positive(),
		work_mb: z.number().int().positive(),
		tmp_mb: z.number().int().positive(),
	}),
	deps: z.array(
		z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
	),
	readiness: z.strictObject({
		command: z.array(z.string().min(1)).min(1),
		marker: z.literal("PI_DURABLE_SEED_READY"),
	}),
	sbom: z.array(
		z.strictObject({
			path: z.string().min(1),
			sha256: Digest,
			bytes: z.number().int().nonnegative(),
		}),
	),
	built_at: z.iso.datetime({ offset: true }),
});
export type SeedManifest = z.infer<typeof SeedManifestSchema>;

/** The ONE parse face for seed/manifest.json content. */
export const parseSeedManifest = (raw: unknown) =>
	SeedManifestSchema.safeParse(raw);

/** Atomic 0600 manifest write — the manifest binds identity digests and
 *  must not be world-readable mid-write. */
export const writeSeedManifest = async (
	dest: string,
	manifest: SeedManifest,
): Promise<void> => {
	const { mkdir, writeFile: wFile } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	const { randomBytes } = await import("node:crypto");
	await mkdir(dirname(dest), { recursive: true });
	const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
	await wFile(tmp, `${JSON.stringify(manifest, null, "\t")}\n`, {
		mode: 0o600,
	});
	const { rename } = await import("node:fs/promises");
	await rename(tmp, dest);
};
