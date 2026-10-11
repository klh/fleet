// hooks/lib/starter-artifacts.ts — W458.1: immutable versioned starter
// artifacts + the project-canonical registry store (spec:
// docs/starter-registry-architecture.md). Laws encoded here:
// - content-addressed: digest = sha256 over canonical JSON of the content;
//   every read re-verifies it — corruption is a loud result, never silent reuse.
// - append-only: one write-once file per (id, version); an existing version
//   is never rewritten, a differing re-put is refused.
// - closed schema: instructions, skill versions, verified findings, source
//   revision, compatibility, provenance, evals — nothing else. A session id
//   is not a portable artifact: no field can carry one.
// - native checkpoints are referenced (harness + pointer), never embedded.
// - no credential material: shared content passes the W454 secret guard.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertNoSecrets } from "./secret-guard.ts";
import { canonicalProjectRoot } from "./lane-registry.ts";

// Re-exported so starter consumers import the guard from one module.
export { assertNoSecrets };

export type StarterCompatibility = { harnesses: string[]; models: string[] };

export type StarterProvenance = {
	authorSid: string;
	promotedBy: string;
	/** BLAM evaluation reference — W458.5 gates promotion on it. */
	evalRef: string;
};

export type StarterEval = { name: string; passed: boolean; at: string };

export type StarterArtifact = {
	id: string;
	version: number;
	createdAt: string;
	instructions: string;
	skillVersions: Record<string, string>;
	findings: string[];
	sourceRevision: string;
	compatibility: StarterCompatibility;
	provenance: StarterProvenance;
	evals: StarterEval[];
	nativeCheckpoint?: { harness: string; ref: string };
	digest: string;
};

/** Content as authored — the store computes and appends `digest`. */
export type StarterArtifactContent = Omit<StarterArtifact, "digest">;

/** Deterministic stringify: sorted object keys, arrays kept in order. */
export const canonicalStarterJson = (value: unknown): string => {
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, val]) => [k, walk(val)]),
			);
		return v;
	};
	return JSON.stringify(walk(value));
};

export const starterArtifactDigest = (
	content: StarterArtifactContent,
): string =>
	createHash("sha256").update(canonicalStarterJson(content)).digest("hex");

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POINTER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA = /^[0-9a-f]{7,64}$/;
const isStr = (v: unknown): v is string => typeof v === "string";
const isIso = (v: unknown): v is string =>
	isStr(v) && !Number.isNaN(Date.parse(v));
const isStrArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((s) => isStr(s) && s.length > 0);

/** Closed-schema validation. Throws with the refusal reason; returns the
 *  content typed. The digest is NOT accepted here — the store computes it,
 *  so content and digest can never drift inside the registry. */
export const validateStarterArtifact = (
	input: unknown,
): StarterArtifactContent => {
	const fail = (why: string): never => {
		throw new Error(`starter artifact refused — ${why}`);
	};
	if (!input || typeof input !== "object" || Array.isArray(input))
		fail("not an object");
	const a = input as Record<string, unknown>;
	const allowed = [
		"id",
		"version",
		"createdAt",
		"instructions",
		"skillVersions",
		"findings",
		"sourceRevision",
		"compatibility",
		"provenance",
		"evals",
		"nativeCheckpoint",
	];
	for (const k of Object.keys(a))
		if (!allowed.includes(k)) fail(`unknown field ${k}`);
	if (!isStr(a.id) || !SLUG.test(a.id)) fail("id must be a [a-z0-9-] slug");
	if (
		typeof a.version !== "number" ||
		!Number.isInteger(a.version) ||
		a.version < 1
	)
		fail("version must be an integer >= 1");
	if (!isIso(a.createdAt)) fail("createdAt must be an ISO timestamp");
	if (!isStr(a.instructions) || a.instructions.trim().length === 0)
		fail("instructions must be a non-empty string");
	if (
		!a.skillVersions ||
		typeof a.skillVersions !== "object" ||
		Array.isArray(a.skillVersions)
	)
		fail("skillVersions must be an object");
	for (const [k, v] of Object.entries(
		a.skillVersions as Record<string, unknown>,
	))
		if (!k || !isStr(v) || v.length === 0)
			fail("skillVersions values must be non-empty strings");
	if (!isStrArray(a.findings)) fail("findings must be non-empty strings");
	if (!isStr(a.sourceRevision) || !SHA.test(a.sourceRevision))
		fail("sourceRevision must be a git sha");
	if (
		!a.compatibility ||
		typeof a.compatibility !== "object" ||
		!isStrArray((a.compatibility as StarterCompatibility).harnesses) ||
		!isStrArray((a.compatibility as StarterCompatibility).models)
	)
		fail("compatibility needs non-empty harnesses + models arrays");
	if (!a.provenance || typeof a.provenance !== "object")
		fail("provenance must be an object");
	const prov = a.provenance as StarterProvenance;
	if (
		!isStr(prov.authorSid) ||
		!isStr(prov.promotedBy) ||
		!isStr(prov.evalRef) ||
		!prov.authorSid ||
		!prov.promotedBy ||
		!prov.evalRef
	)
		fail("provenance needs authorSid + promotedBy + evalRef");
	if (!Array.isArray(a.evals)) fail("evals must be an array");
	for (const e of a.evals) {
		const row = e as StarterEval;
		if (
			!e ||
			typeof e !== "object" ||
			!isStr(row.name) ||
			!row.name ||
			typeof row.passed !== "boolean" ||
			!isIso(row.at)
		)
			fail("evals rows need name, passed, at");
	}
	if (a.nativeCheckpoint !== undefined) {
		const nc = a.nativeCheckpoint as { harness?: unknown; ref?: unknown };
		if (!nc || typeof nc !== "object" || !isStr(nc.harness) || !nc.harness)
			fail("nativeCheckpoint.harness must be a non-empty string");
		if (!isStr(nc.ref) || !POINTER.test(nc.ref))
			fail(
				"nativeCheckpoint.ref must be a pointer token — a checkpoint is referenced, never embedded",
			);
	}
	// Shared content must never carry credential material.
	assertNoSecrets(canonicalStarterJson(a));
	return input as StarterArtifactContent;
};

/** Project-canonical registry: every worktree of the repo shares one store
 *  (git common dir), so two developers on two hubs read the same immutable
 *  artifacts — the first-milestone topology, one project one registry. */
export const starterRegistryDir = (repo: string): string =>
	join(canonicalProjectRoot(repo), ".fleet", "starter-registry");

const versionFile = (dir: string, id: string, version: number): string =>
	join(dir, id, `v${version}.json`);

export type StarterPutResult = StarterArtifact & { duplicate: boolean };

/** Append a version. Byte-identical re-put is an idempotent duplicate; any
 *  other collision with an existing version is refused — the registry is
 *  append-only and the file is write-once (`wx`), so concurrent puts of one
 *  version cannot silently overwrite each other. */
export const putStarter = (
	repo: string,
	content: StarterArtifactContent,
): StarterPutResult => {
	const a = validateStarterArtifact(content);
	const digest = starterArtifactDigest(a);
	const dir = starterRegistryDir(repo);
	const body = JSON.stringify({ ...a, digest });
	const file = versionFile(dir, a.id, a.version);
	if (existsSync(file)) {
		if (readFileSync(file, "utf8") === body)
			return { ...a, digest, duplicate: true };
		throw new Error(
			`starter registry refused — ${a.id} v${a.version} already exists with different content (append-only)`,
		);
	}
	mkdirSync(join(dir, a.id), { recursive: true });
	writeFileSync(file, body, { mode: 0o600, flag: "wx" });
	return { ...a, digest, duplicate: false };
};

export type StarterGet =
	| { ok: true; artifact: StarterArtifact }
	| { ok: false; missing: true }
	| { ok: false; corrupt: string };

const versionFiles = (idDir: string): number[] =>
	readdirSync(idDir)
		.filter((f) => /^v\d+\.json$/.test(f))
		.map((f) => Number.parseInt(f.slice(1), 10))
		.sort((x, y) => x - y);

/** Read one version (default: newest). Missing and corrupt are RESULTS, not
 *  exceptions — a caller must never end up using bytes that failed the
 *  digest check (content-addressed integrity on every read). */
export const getStarter = (
	repo: string,
	id: string,
	version?: number,
): StarterGet => {
	const dir = starterRegistryDir(repo);
	const idDir = join(dir, id);
	if (!existsSync(idDir)) return { ok: false, missing: true };
	const versions = versionFiles(idDir);
	if (versions.length === 0) return { ok: false, missing: true };
	const want = version ?? versions[versions.length - 1];
	if (!existsSync(versionFile(dir, id, want)))
		return { ok: false, missing: true };
	try {
		const parsed = JSON.parse(
			readFileSync(versionFile(dir, id, want), "utf8"),
		) as Record<string, unknown>;
		const { digest, ...content } = parsed;
		const checked = validateStarterArtifact(content);
		const computed = starterArtifactDigest(checked);
		if (!isStr(digest) || digest !== computed)
			return { ok: false, corrupt: `${id} v${want}: digest mismatch` };
		return { ok: true, artifact: { ...checked, digest } };
	} catch (error) {
		return { ok: false, corrupt: `${id} v${want}: ${String(error)}` };
	}
};

export type StarterListRow = {
	id: string;
	version: number;
	digest?: string;
	createdAt?: string;
	corrupt?: string;
};

/** Inventory against a REGISTRY ROOT (a bundle/mirror dir with the same
 *  layout, no repo wrapper needed). */
export const listStartersIn = (dir: string, id?: string): StarterListRow[] => {
	if (!existsSync(dir)) return [];
	const ids = id ? [id] : readdirSync(dir).sort();
	const rows: StarterListRow[] = [];
	for (const one of ids) {
		const idDir = join(dir, one);
		// only id directories — the registry dir also carries authz.json and
		// revocations.jsonl (W458.2), which are not starter ids
		if (!existsSync(idDir) || !statSync(idDir).isDirectory()) continue;
		for (const v of versionFiles(idDir)) {
			try {
				const parsed = JSON.parse(
					readFileSync(versionFile(dir, one, v), "utf8"),
				) as Record<string, unknown>;
				rows.push({
					id: one,
					version: v,
					digest: isStr(parsed.digest) ? parsed.digest : undefined,
					createdAt: isIso(parsed.createdAt) ? parsed.createdAt : undefined,
				});
			} catch (error) {
				rows.push({ id: one, version: v, corrupt: String(error) });
			}
		}
	}
	return rows;
};

/** Inventory against a repo (the worktree-shared project registry). */
export const listStarters = (repo: string, id?: string): StarterListRow[] =>
	listStartersIn(starterRegistryDir(repo), id);
