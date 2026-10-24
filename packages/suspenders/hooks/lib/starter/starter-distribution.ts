// hooks/lib/starter/starter-distribution.ts — W458.2: registry authorization,
// revocation, and hub replication for the starter registry (architecture
// record: docs/starter-milestone-w458-6.md). Laws:
// - grants fail closed: no authz file = nobody promotes or revokes;
// - revocation is append-only NDJSON and beats the local copy — a hub that
//   holds a revoked starter is still refused at read time;
// - replication ships immutable bytes + the revocation log under the same
//   write-once discipline as the registry itself;
// - grants and revocations are runtime config (.fleet, 0600, untracked):
//   config-over-code, repos never carry principal lists.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	getStarter,
	listStarters,
	listStartersIn,
	putStarter,
	starterRegistryDir,
	type StarterArtifact,
	type StarterArtifactContent,
	type StarterPutResult,
} from "./starter-artifacts.ts";

export type StarterGrants = {
	promoters: string[];
	revokers: string[];
	/** Who may materialize starter content — the per-task auth recheck the
	 *  materialization contract runs (W458.3). Absent = fail-closed. */
	readers?: string[];
};

export const starterAuthzFile = (repo: string): string =>
	join(starterRegistryDir(repo), "authz.json");
export const starterRevocationsFile = (repo: string): string =>
	join(starterRegistryDir(repo), "revocations.jsonl");

const nonEmpty = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0;

/** Registry grants: WHO may promote or revoke. Runtime config, mode 0600,
 *  untracked (.fleet is gitignored) — config-over-code. Fail-closed: a
 *  missing or corrupt file means nobody holds authority. */
export const readGrants = (repo: string): StarterGrants => {
	const f = starterAuthzFile(repo);
	if (!existsSync(f)) return { promoters: [], revokers: [], readers: [] };
	try {
		const parsed = JSON.parse(readFileSync(f, "utf8")) as Record<
			string,
			unknown
		>;
		const ids = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((s) => nonEmpty(s)) : [];
		return {
			promoters: ids(parsed.promoters),
			revokers: ids(parsed.revokers),
			readers: ids(parsed.readers),
		};
	} catch {
		return { promoters: [], revokers: [], readers: [] };
	}
};
export const writeGrants = (repo: string, grants: StarterGrants): void => {
	mkdirSync(starterRegistryDir(repo), { recursive: true });
	writeFileSync(
		starterAuthzFile(repo),
		`${JSON.stringify(grants, null, "\t")}\n`,
		{ mode: 0o600 },
	);
};

const failClosed = (verb: string, sid: string): never => {
	throw new Error(
		`starter authz refused — ${sid.slice(0, 8)} holds no ${verb} grant`,
	);
};

/** Promotion authority: promoteStarter is the ONLY promoted-artifact path —
 *  the plain putStarter stays for replication/bootstrap internals. */
export const assertCanPromote = (repo: string, sid: string): void => {
	if (!readGrants(repo).promoters.includes(sid)) failClosed("promote", sid);
};

export const assertCanRevoke = (repo: string, sid: string): void => {
	if (!readGrants(repo).revokers.includes(sid)) failClosed("revoke", sid);
};

/** Materialization-time auth recheck (W458.3): permissions are rechecked
 *  when the artifact is materialized, never assumed from earlier state. */
export const assertCanRead = (repo: string, sid: string): void => {
	if (!readGrants(repo).readers.includes(sid)) failClosed("materialize", sid);
};

export type StarterRevocation = {
	id: string;
	/** null = every version of the starter. */
	version: number | null;
	reason: string;
	at: string;
	by: string;
};

/** Append a revocation row. Append-only NDJSON; the row is minted here —
 *  at/by are set by the registry, never taken from the caller. */
export const appendRevocation = (
	repo: string,
	actor: string,
	rev: { id: string; version?: number; reason: string },
): StarterRevocation => {
	assertCanRevoke(repo, actor);
	const row: StarterRevocation = {
		id: rev.id,
		version: rev.version ?? null,
		reason: rev.reason,
		at: new Date().toISOString(),
		by: actor,
	};
	mkdirSync(starterRegistryDir(repo), { recursive: true });
	appendFileSync(starterRevocationsFile(repo), `${JSON.stringify(row)}\n`);
	return row;
};

/** All revocation rows in order (empty when the log is absent). */
export const readRevocations = (repo: string): StarterRevocation[] => {
	const f = starterRevocationsFile(repo);
	if (!existsSync(f)) return [];
	const lines = readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	return lines.map((l) => JSON.parse(l) as StarterRevocation);
};

/** The revocation that kills this (id, version), if any: an exact-version
 *  row beats a null (all-versions) row only in specificity — either refuses
 *  the read. */
export const revocationFor = (
	repo: string,
	id: string,
	version: number,
): StarterRevocation | null =>
	readRevocations(repo).find(
		(r) => r.id === id && (r.version === null || r.version === version),
	) ?? null;

export type StarterRead =
	| { ok: true; artifact: StarterArtifact }
	| { ok: false; missing: true }
	| { ok: false; corrupt: string }
	| { ok: false; revoked: string };

/** The authorized read: digest-verified bytes from the store, THEN the
 *  revocation gate. A hub must not silently use a revoked starter merely
 *  because it holds a local copy — refusal is observable, with the reason. */
export const readStarterAuthorized = (
	repo: string,
	id: string,
	version?: number,
): StarterRead => {
	const got = getStarter(repo, id, version);
	if (!got.ok) return got;
	const rev = revocationFor(repo, got.artifact.id, got.artifact.version);
	if (rev)
		return {
			ok: false,
			revoked: `${got.artifact.id} v${got.artifact.version} revoked by ${rev.by.slice(0, 8)}: ${rev.reason}`,
		};
	return got;
};

/** Promotion: authority check + append. The one sanctioned promote path —
 *  plain putStarter remains for replication/bootstrap internals. */
export const promoteStarter = (
	repo: string,
	actor: string,
	content: StarterArtifactContent,
): StarterPutResult => {
	assertCanPromote(repo, actor);
	return putStarter(repo, content);
};

export type StarterReplicationRow = {
	id: string;
	version: number;
	status: "wrote" | "duplicate" | "refused-corrupt-source";
};

export type StarterReplicationReport = {
	rows: StarterReplicationRow[];
	/** Revocation rows appended at the target (dedupe: exact line match). */
	revocations: number;
};

/** Write-once copy: identical bytes = duplicate (no-op), any other collision
 *  = refusal. Immutable bytes never get rewritten in either direction. */
const copyOnce = (from: string, to: string): "wrote" | "duplicate" => {
	if (!existsSync(to)) {
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, readFileSync(from), { mode: 0o600 });
		return "wrote";
	}
	const same = readFileSync(to).equals(readFileSync(from));
	if (!same)
		throw new Error(
			`starter replication refused — ${basename(to)} exists with different bytes`,
		);
	return "duplicate";
};

/** Append revocation rows the target lacks, in order, via node:fs append
 *  (never Bun {append:true} — it rewrites). */
const mergeRevocations = (fromFile: string, toFile: string): number => {
	if (!existsSync(fromFile)) return 0;
	const incoming = readFileSync(fromFile, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	const have = existsSync(toFile)
		? new Set(
				readFileSync(toFile, "utf8")
					.split("\n")
					.filter((l) => l.trim()),
			)
		: new Set();
	let wrote = 0;
	mkdirSync(dirname(toFile), { recursive: true });
	for (const line of incoming) {
		if (have.has(line)) continue;
		appendFileSync(toFile, `${line}\n`);
		wrote += 1;
	}
	return wrote;
};

/** Ship the local registry to a hub dir: artifact bytes (healthy rows only —
 *  corrupt source rows are refused, never replicated) + the revocation log. */
export const replicateToDir = (
	repo: string,
	targetDir: string,
): StarterReplicationReport => {
	const dir = starterRegistryDir(repo);
	const rows: StarterReplicationRow[] = [];
	mkdirSync(targetDir, { recursive: true });
	for (const row of listStarters(repo)) {
		const file = join(row.id, `v${row.version}.json`);
		if (row.corrupt) {
			rows.push({
				id: row.id,
				version: row.version,
				status: "refused-corrupt-source",
			});
			continue;
		}
		const status = copyOnce(join(dir, file), join(targetDir, file));
		rows.push({ id: row.id, version: row.version, status });
	}
	const revocations = mergeRevocations(
		starterRevocationsFile(repo),
		join(targetDir, "revocations.jsonl"),
	);
	return { rows, revocations };
};

/** Pull from an origin dir into the local registry — the hub side. Same
 *  write-once discipline; revocations merge before any lane reads. */
export const pullFromDir = (
	repo: string,
	originDir: string,
): StarterReplicationReport => {
	const dir = starterRegistryDir(repo);
	const rows: StarterReplicationRow[] = [];
	mkdirSync(dir, { recursive: true });
	for (const row of listStartersIn(originDir)) {
		const file = join(row.id, `v${row.version}.json`);
		if (row.corrupt) {
			rows.push({
				id: row.id,
				version: row.version,
				status: "refused-corrupt-source",
			});
			continue;
		}
		const status = copyOnce(join(originDir, file), join(dir, file));
		rows.push({ id: row.id, version: row.version, status });
	}
	const revocations = mergeRevocations(
		join(originDir, "revocations.jsonl"),
		starterRevocationsFile(repo),
	);
	return { rows, revocations };
};

export type StarterRollbackRecord = {
	starter: string;
	from: number;
	to: number;
	fromDigest: string;
	toDigest: string;
	reason: string;
	at: string;
	by: string;
};

export const starterRollbacksFile = (repo: string): string =>
	join(starterRegistryDir(repo), "rollbacks.jsonl");

/** Execute a blam-resolved rollback (W458.5): revoke the bad version and
 *  append the pointer record. Blam decides, the registry executes — both
 *  appends, never rewrites. */
export const rollbackStarter = (
	repo: string,
	actor: string,
	plan: {
		starter: string;
		from: number;
		fromDigest: string;
		to: number;
		toDigest: string;
	},
	reason: string,
): StarterRollbackRecord => {
	assertCanRevoke(repo, actor);
	const row: StarterRollbackRecord = {
		...plan,
		reason,
		at: new Date().toISOString(),
		by: actor,
	};
	mkdirSync(starterRegistryDir(repo), { recursive: true });
	appendRevocation(repo, actor, {
		id: plan.starter,
		version: plan.from,
		reason: `rollback: ${reason}`,
	});
	appendFileSync(starterRollbacksFile(repo), `${JSON.stringify(row)}\n`);
	return row;
};

/** Every rollback record, in order (tolerant reader). */
export const readRollbacks = (repo: string): StarterRollbackRecord[] => {
	const f = starterRollbacksFile(repo);
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as StarterRollbackRecord);
};
