// hooks/lib/starter-materialize.ts — W458.3: the per-task materialization
// contract (spec: docs/starter-registry-architecture.md). Laws:
// - permissions rechecked at materialization (assertCanRead) — earlier
//   authorization is never assumed;
// - freshness + compatibility filter BEFORE ranking; rank = measured
//   outcomes (eval pass rate, then newest version);
// - the route is recorded, never assumed: native fork when the harness
//   adapter supports it, reconstruction from the artifact otherwise —
//   fork-session resolution stays dispatch's spawn-time concern (W454);
// - shared prep never implies shared ownership: the identity that built or
//   promoted a starter can never materialize it as its own lane;
// - outcomes append to NDJSON for baselines and promotion evals.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertCanRead,
	readStarterAuthorized,
	type StarterArtifact,
	type StarterRead,
} from "./starter-distribution.ts";
import { listStarters, starterRegistryDir } from "./starter-artifacts.ts";
import { adapterForExact } from "./executors/registry.ts";

export type MaterializeIdentity = {
	sid: string;
	task: string;
	worktree: string;
};

export type MaterializeRequest = {
	repo: string;
	/** Authenticated developer/lane — rechecked at materialization. */
	actor: string;
	task: string;
	harness: string;
	model: string;
	/** Pin a starter, or omit to rank every compatible starter. */
	id?: string;
	/** The FRESH lane identity dispatch allocated — recorded in evidence and
	 *  materialization refuses identity reuse from provenance. */
	identity: MaterializeIdentity;
};

export type MaterializationRoute = "native-fork" | "reconstructed";

export type RankedStarter = {
	id: string;
	version: number;
	digest: string;
	passRate: number;
};

export type Materialization = {
	route: MaterializationRoute;
	starter: { id: string; version: number; digest: string };
	/** Reconstruction payload — the shared prefix a cold lane starts from. */
	prompt: string;
	evidence: {
		authRecheck: "ok";
		freshness: { maxAgeDays: number; ageDays: number };
		compatibility: { harness: string; model: string };
		ranked: RankedStarter[];
		refusals: string[];
	};
};

export type MaterializeResult = Materialization | { refused: string };

export const STARTER_FRESH_DAYS = "STARTER_FRESH_DAYS";
const DEFAULT_FRESH_DAYS = 30;

/** Freshness policy knob (explicit, not an implicit TTL): max artifact age
 *  in days, default 30, 0 disables the freshness filter. */
export const starterFreshDays = (
	env: Record<string, string | undefined> = process.env as Record<
		string,
		string | undefined
	>,
): number => {
	const raw = env[STARTER_FRESH_DAYS];
	if (!raw) return DEFAULT_FRESH_DAYS;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FRESH_DAYS;
};

const ageDaysOf = (artifact: StarterArtifact, now: number): number =>
	Math.max(0, (now - Date.parse(artifact.createdAt)) / 86_400_000);

const passRateOf = (a: StarterArtifact): number =>
	a.evals.length === 0
		? 0
		: a.evals.filter((e) => e.passed).length / a.evals.length;

const forkCapable = (harness: string): boolean =>
	adapterForExact(harness)?.forkArgs("ROUTE-PROBE") != null;

const readWhy = (read: StarterRead): string =>
	"missing" in read ? "missing" : "corrupt" in read ? "corrupt" : "revoked";

/** The materialization contract, per task, in order: authenticate + tenant
 *  recheck → freshness/compatibility filter → rank by measured outcomes →
 *  route decision (fork vs reconstruct, recorded) → identity separation →
 *  evidence. Refusal is a first-class result — observable, with reasons. */
export const materializeStarter = (
	req: MaterializeRequest,
	options: { now?: () => number } = {},
): MaterializeResult => {
	const now = (options.now ?? Date.now)();
	const refusals: string[] = [];
	const refuse = (why: string): MaterializeResult => ({ refused: why });
	try {
		assertCanRead(req.repo, req.actor);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
	const maxAge = starterFreshDays();
	const ranked: RankedStarter[] = [];
	let best: StarterArtifact | null = null;
	let bestRate = -1;
	for (const row of listStarters(req.repo, req.id)) {
		const read = readStarterAuthorized(req.repo, row.id, row.version);
		if (!read.ok) {
			refusals.push(`${row.id} v${row.version}: ${readWhy(read)}`);
			continue;
		}
		const a = read.artifact;
		const compatible =
			a.compatibility.harnesses.includes(req.harness) &&
			a.compatibility.models.includes(req.model);
		const age = ageDaysOf(a, now);
		if (!compatible) {
			refusals.push(`${row.id} v${row.version}: incompatible harness/model`);
			continue;
		}
		if (maxAge > 0 && age > maxAge) {
			refusals.push(`${row.id} v${row.version}: stale`);
			continue;
		}
		const rate = passRateOf(a);
		ranked.push({
			id: a.id,
			version: a.version,
			digest: a.digest,
			passRate: rate,
		});
		const wins =
			rate > bestRate ||
			(rate === bestRate && (best === null || a.version > best.version));
		if (wins) {
			best = a;
			bestRate = rate;
		}
	}
	if (!best) {
		return refuse(
			`no compatible fresh authorized starter${req.id ? ` for ${req.id}` : ""}${refusals.length ? `; refusals: ${refusals.join("; ")}` : ""}`,
		);
	}
	if (
		req.identity.sid === best.provenance.authorSid ||
		req.identity.sid === best.provenance.promotedBy
	) {
		return refuse(
			`identity ${req.identity.sid.slice(0, 8)} built or promoted this starter — fresh identity required`,
		);
	}
	return {
		route: forkCapable(req.harness) ? "native-fork" : "reconstructed",
		starter: { id: best.id, version: best.version, digest: best.digest },
		prompt: best.instructions,
		evidence: {
			authRecheck: "ok",
			freshness: {
				maxAgeDays: maxAge,
				ageDays: Math.round(ageDaysOf(best, now)),
			},
			compatibility: { harness: req.harness, model: req.model },
			ranked,
			refusals,
		},
	};
};

export type StarterOutcome = {
	task: string;
	sid: string;
	starter: { id: string; version: number; digest: string };
	route: MaterializationRoute;
	/** Gateway-reported per-lane cache/cost telemetry (W458.4 feeds this). */
	cache: { writes?: number; reads?: number; misses?: number } | null;
	costUsd?: number;
	outcome: "verified" | "failed";
	at: string;
};

export const starterOutcomesFile = (repo: string): string =>
	join(starterRegistryDir(repo), "outcomes.jsonl");

/** Append the per-task selection evidence — cache/cost arrive from the
 *  gateway's per-lane telemetry (W458.4), the verified outcome from the
 *  lane's own gate. Append-only NDJSON via node:fs. */
export const recordOutcome = (repo: string, row: StarterOutcome): void => {
	mkdirSync(starterRegistryDir(repo), { recursive: true });
	appendFileSync(starterOutcomesFile(repo), `${JSON.stringify(row)}\n`);
};

/** Every recorded outcome, in order. */
export const readOutcomes = (repo: string): StarterOutcome[] => {
	const f = starterOutcomesFile(repo);
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as StarterOutcome);
};
