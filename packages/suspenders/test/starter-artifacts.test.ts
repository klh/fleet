// test/starter-artifacts.test.ts — W458.1: immutable versioned starter
// artifact schema + project-canonical registry store. Covered: digest
// determinism (key-order independent), closed-schema refusals (unknown
// fields, secret guard, embedded checkpoints), append-only put (duplicate
// vs conflicting), digest-verified reads (corrupt is a result, not a crash),
// tolerant inventory, project-canonical registry path.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoSecrets,
	canonicalStarterJson,
	getStarter,
	listStarters,
	putStarter,
	starterArtifactDigest,
	starterRegistryDir,
	validateStarterArtifact,
	type StarterArtifactContent,
} from "../hooks/lib/starter/starter-artifacts.ts";

const scratch = (): string => {
	const d = join(
		tmpdir(),
		`w4581-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(d, { recursive: true });
	return d;
};

const base = (): StarterArtifactContent => ({
	id: "fleet-orientation",
	version: 1,
	createdAt: "2026-10-11T00:00:00.000Z",
	instructions: "Repo law + fleet protocol. Acknowledge with READY.",
	skillVersions: { "klh-lit-dev": "1.2.3" },
	findings: ["finding.w454"],
	sourceRevision: "7a4119500112233445566778899aabbccddeeff0",
	compatibility: { harnesses: ["claude"], models: ["glm-5.3-flash"] },
	provenance: {
		authorSid: "autow458-1",
		promotedBy: "autow458-5",
		evalRef: "blam://starter-eval/fleet-orientation-v1",
	},
	evals: [
		{ name: "orientation-smoke", passed: true, at: "2026-10-11T00:00:00.000Z" },
	],
});

describe("starter-artifacts: digest", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("key order never changes the digest, content does", () => {
		const a = base();
		const shuffled: StarterArtifactContent = {
			evals: a.evals,
			sourceRevision: a.sourceRevision,
			provenance: a.provenance,
			compatibility: a.compatibility,
			skillVersions: a.skillVersions,
			findings: a.findings,
			instructions: a.instructions,
			createdAt: a.createdAt,
			version: a.version,
			id: a.id,
		};
		expect(starterArtifactDigest(shuffled)).toBe(starterArtifactDigest(a));
		const flipped = base();
		flipped.evals[0].passed = false;
		expect(starterArtifactDigest(flipped)).not.toBe(
			starterArtifactDigest(base()),
		);
	});
});
describe("starter-artifacts: closed-schema refusals", () => {
	test("unknown fields are refused — digest included", () => {
		expect(() =>
			validateStarterArtifact({ ...base(), digest: "deadbeef" }),
		).toThrow(/unknown field digest/);
	});

	test("scalar field refusals", () => {
		const v0 = base();
		v0.version = 0;
		expect(() => validateStarterArtifact(v0)).toThrow(/version/);
		const badId = base();
		badId.id = "Bad_Id";
		expect(() => validateStarterArtifact(badId)).toThrow(/id must be/);
		const badSha = base();
		badSha.sourceRevision = "not-a-sha";
		expect(() => validateStarterArtifact(badSha)).toThrow(/sourceRevision/);
	});

	test("secrets never pass — in instructions or checkpoint refs", () => {
		const secret = base();
		secret.instructions = "use token ghp_ABCDEFGHIJ1234 upstream";
		expect(() => validateStarterArtifact(secret)).toThrow(/secret guard/);
		const leakyRef = base();
		leakyRef.nativeCheckpoint = { harness: "claude", ref: "sk-abcdef123456" };
		expect(() => validateStarterArtifact(leakyRef)).toThrow(/secret guard/);
	});

	test("native checkpoints are pointers, never embedded content", () => {
		const embedded = base();
		embedded.nativeCheckpoint = {
			harness: "claude",
			ref: "a checkpoint with spaces",
		};
		expect(() => validateStarterArtifact(embedded)).toThrow(/pointer token/);
	});
});
describe("starter-artifacts: store roundtrip", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("put + get: newest by default, explicit versions, missing is a result", () => {
		const v1 = putStarter(repo, base());
		expect(v1.duplicate).toBe(false);
		const got = getStarter(repo, "fleet-orientation");
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.artifact.digest).toBe(v1.digest);
		const v2 = base();
		v2.version = 2;
		v2.instructions = "Repo law + fleet protocol, v2 wording.";
		putStarter(repo, v2);
		const newest = getStarter(repo, "fleet-orientation");
		if (newest.ok) expect(newest.artifact.version).toBe(2);
		const explicit = getStarter(repo, "fleet-orientation", 1);
		if (explicit.ok) expect(explicit.artifact.version).toBe(1);
		expect(getStarter(repo, "absent").missing).toBe(true);
		expect(getStarter(repo, "fleet-orientation", 9).missing).toBe(true);
	});
});
describe("starter-artifacts: append-only", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("duplicate re-put is idempotent; conflicting re-put refused", () => {
		const v1 = putStarter(repo, base());
		const again = putStarter(repo, base());
		expect(again.duplicate).toBe(true);
		expect(again.digest).toBe(v1.digest);
		const clash = base();
		clash.instructions = "rewritten history — must never land";
		expect(() => putStarter(repo, clash)).toThrow(/append-only/);
		const got = getStarter(repo, "fleet-orientation");
		if (got.ok) expect(got.artifact.instructions).toBe(base().instructions);
	});
});
describe("starter-artifacts: corruption + inventory", () => {
	const repo = scratch();
	afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("tampered bytes read as corrupt, never as an artifact", () => {
		putStarter(repo, base());
		const file = join(
			repo,
			".fleet",
			"starter-registry",
			"fleet-orientation",
			"v1.json",
		);
		const original = readFileSync(file, "utf8");
		writeFileSync(file, original.replace("READY", "READY-TAMPERED"));
		const tampered = getStarter(repo, "fleet-orientation");
		expect(tampered.ok).toBe(false);
		if (!tampered.ok && "corrupt" in tampered)
			expect(tampered.corrupt).toMatch(/digest mismatch/);
		writeFileSync(file, original.slice(0, 40));
		const truncated = getStarter(repo, "fleet-orientation");
		expect(truncated.ok).toBe(false);
	});

	test("inventory marks the corrupt row, lists the healthy one", () => {
		putStarter(repo, base());
		const broken = base();
		broken.id = "broken-starter";
		putStarter(repo, broken);
		const bad = join(
			repo,
			".fleet",
			"starter-registry",
			"broken-starter",
			"v1.json",
		);
		writeFileSync(bad, "{not json");
		const rows = listStarters(repo);
		expect(rows.length).toBe(2);
		const marked = rows.find((r) => r.id === "broken-starter");
		expect(marked?.corrupt).toBeTruthy();
		expect(listStarters(repo, "fleet-orientation").length).toBe(1);
		expect(listStarters(repo, "absent")).toEqual([]);
	});
});
describe("starter-artifacts: registry placement", () => {
	test("registry is project-canonical under .fleet/starter-registry", () => {
		const repo = scratch();
		expect(
			starterRegistryDir(repo).endsWith(join(".fleet", "starter-registry")),
		).toBe(true);
		rmSync(repo, { recursive: true, force: true });
	});

	test("canonical json sorts nested keys; guard is the one-arg W454 guard", () => {
		expect(canonicalStarterJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
			'{"a":[2,{"c":4,"d":3}],"b":1}',
		);
		expect(assertNoSecrets.length).toBe(1);
	});
});
