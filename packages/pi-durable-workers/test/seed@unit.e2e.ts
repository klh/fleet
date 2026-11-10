// test/seed@unit.e2e.ts — W2958: the Pi Durable seed contract tests.
// Hermetic (no docker, no network): the manifest schema face, the two
// byte-compatible host contracts pinned by vectors computed FROM the
// suspenders runner implementations, the Dockerfile isolation contract,
// and the readiness core with injected stubs.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	canonicalPolicyDigest,
	canonicalSeedDigest,
	digestOf,
	parseSeedManifest,
	type SeedFile,
	type SeedPolicy,
} from "../src/seed-manifest.ts";
import {
	runReadinessChecks,
	type ReadinessProbes,
} from "../src/seed-readiness.ts";

const PKG = resolve(import.meta.dir, "..");

// — host-contract parity vectors (computed with the REAL suspenders
// implementations: desktop/seed.ts canonicalSeedDigest over the fixture
// set {a/b/two.md:"bee", a/one.txt:"hello a", top.bin:"gamma"} and
// docker-executor.ts canonicalPolicyDigest over the executor defaults
// with the placeholder image below). A divergence means the seed
// manifest would bind digests the host will refuse. —

const VECTOR_FILES: SeedFile[] = [
	{ path: "a/one.txt", bytes: new TextEncoder().encode("hello a") },
	{ path: "a/b/two.md", bytes: new TextEncoder().encode("bee") },
	{ path: "top.bin", bytes: new TextEncoder().encode("gamma") },
];
const SEED_VECTOR =
	"4da50ce3bc10f42cc7f655f3eb0d8d32e4160577233d3bdd6016f0bb355adddd";

const VECTOR_POLICY: SeedPolicy = {
	image: `klh/pi-durable-seed:W2958@sha256:${"0".repeat(64)}`,
	network: "none",
	readOnlyRoot: true,
	capDropAll: true,
	noNewPrivileges: true,
	user: "1000:1000",
	memoryMb: 512,
	cpus: 1,
	pidsLimit: 128,
	workMb: 128,
	tmpMb: 64,
};
const POLICY_VECTOR =
	"a13509d7c6503daba02941f9e2323710d663113f0510334bceeafad70e642ff3";

test("canonical seed digest matches the runner-host vector", () => {
	expect(canonicalSeedDigest(VECTOR_FILES)).toBe(SEED_VECTOR);
});

test("canonical policy digest matches the executor vector", () => {
	expect(canonicalPolicyDigest(VECTOR_POLICY)).toBe(POLICY_VECTOR);
});

test("seed digest is order-noise immune (same set, shuffled input)", () => {
	const shuffled = [...VECTOR_FILES].reverse();
	expect(canonicalSeedDigest(shuffled)).toBe(SEED_VECTOR);
});

test("policy digest changes when any limit changes", () => {
	const drifted = { ...VECTOR_POLICY, memoryMb: 1024 };
	expect(canonicalPolicyDigest(drifted)).not.toBe(POLICY_VECTOR);
});

// — manifest schema face —

const validManifest = {
	schema_version: 1,
	kind: "pi-durable-seed",
	name: "klh/pi-durable-seed",
	version: "2.2.0",
	source: {
		revision: "a".repeat(40),
		dirty: false,
		package: "@klh/pi-durable-workers",
	},
	base_image: `oven/bun:1@sha256:${"9".repeat(64)}`,
	runtime_image: `klh/pi-durable-seed@sha256:${"8".repeat(64)}`,
	platform: "linux/amd64",
	seed: { digest: "b".repeat(64), files: 12, bytes: 2048 },
	policy: {
		digest: "c".repeat(64),
		user: "1000:1000",
		memory_mb: 512,
		cpus: 1,
		pids_limit: 128,
		work_mb: 128,
		tmp_mb: 64,
	},
	deps: [{ name: "zod", version: "4.6.7" }],
	readiness: {
		command: ["bun", "run", "seed/readiness.ts"],
		marker: "PI_DURABLE_SEED_READY",
	},
	sbom: [{ path: "package.json", sha256: "d".repeat(64), bytes: 512 }],
	built_at: "2026-11-10T12:00:00.000Z",
};

test("manifest schema accepts a well-formed manifest", () => {
	const parsed = parseSeedManifest(validManifest);
	expect(parsed.success).toBe(true);
});

test("manifest schema refuses an unpinned runtime image", () => {
	const bad = {
		...validManifest,
		runtime_image: "klh/pi-durable-seed:latest",
	};
	const parsed = parseSeedManifest(bad);
	expect(parsed.success).toBe(false);
});

test("manifest schema refuses a wrong platform", () => {
	const bad = { ...validManifest, platform: "linux/arm64" };
	const parsed = parseSeedManifest(bad);
	expect(parsed.success).toBe(false);
});

test("manifest schema refuses extra fields (strictObject)", () => {
	const bad = { ...validManifest, surprise: true };
	const parsed = parseSeedManifest(bad);
	expect(parsed.success).toBe(false);
});

test("manifest schema refuses a non-hex seed digest", () => {
	const bad = {
		...validManifest,
		seed: { ...validManifest.seed, digest: "zz".repeat(32) },
	};
	const parsed = parseSeedManifest(bad);
	expect(parsed.success).toBe(false);
});

// — Dockerfile isolation contract —

const dockerfile = () =>
	readFileSync(join(PKG, "seed/payload/Dockerfile"), "utf8");

test("Dockerfile pins the base image by digest and platform", () => {
	const text = dockerfile();
	expect(text).toMatch(
		/^FROM --platform=linux\/amd64 oven\/bun:1@sha256:[a-f0-9]{64}$/m,
	);
});

test("Dockerfile runs unprivileged by default (runner uid pair)", () => {
	expect(dockerfile()).toMatch(/^USER 1000:1000$/m);
});

test("Dockerfile stages no credentials, env files or repo history", () => {
	// Instruction lines only — prose comments may document what is NOT
	// staged; the contract is what the build actually copies/runs.
	const instructions = dockerfile()
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^(FROM|RUN|COPY|ADD|ENV|CMD|ENTRYPOINT)\b/.test(l));
	for (const line of instructions) {
		for (const forbidden of [".env", ".git", "id_rsa", "credential", ".key"]) {
			expect(line).not.toContain(forbidden);
		}
	}
});

test("Dockerfile freezes deps from the staged lockfile without scripts", () => {
	const text = dockerfile();
	expect(text).toContain(
		"bun install --production --frozen-lockfile --ignore-scripts",
	);
});

// — readiness core (injected stubs; the real probes run inside the image
// during seed:build smokes) —

const probes = (over: Partial<ReadinessProbes>): ReadinessProbes => ({
	bunVersion: () => "1.4.2.0",
	expectedBun: "1.4.2",
	extensionLoads: () => true,
	extensionShape: () => true,
	registryInstantiates: () => true,
	gitVersion: () => "git version 2.39.5",
	tmpWritable: () => true,
	...over,
});

test("readiness passes when every check passes", () => {
	const result = runReadinessChecks(probes({}));
	expect(result.ready).toBe(true);
	expect(result.reason).toBeUndefined();
});

test("readiness refuses a wrong bun", () => {
	const result = runReadinessChecks(probes({ bunVersion: () => "1.5.0" }));
	expect(result.ready).toBe(false);
	expect(result.checks.bun_pinned).toBe(false);
});

test("readiness refuses missing git with the failed check named", () => {
	const result = runReadinessChecks(probes({ gitVersion: () => null }));
	expect(result.ready).toBe(false);
	expect(result.reason).toBe("failed: git_present");
});

test("digestOf matches sha256-hex over bytes and strings", () => {
	expect(digestOf("gamma")).toBe(digestOf(new TextEncoder().encode("gamma")));
	expect(digestOf("")).toBe(
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});
