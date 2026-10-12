// hooks/lib/executor-cv.ts — W620: the executor trust tally (BOINC adaptive
// replication's CV(H,V) counter — docs/grid-coordination-research.md item B,
// confirmed by harness-lift-research.md's Gas City reliability report).
// A READER over the EXISTING work bus: work.done whose sha the W60 ancestry
// probe confirms is on main is a validated result (cv++); a reclaim or fail
// zeroes the class counter. Facts `executor.<host>.<model>.cv` carry the
// tally to pick time; execPick reorders the DEFAULT ladder only — never a
// .prefer MUST chain (W228). No new emission: the fold adds zero events.
import { hostname } from "node:os";
import { shaOnMain } from "./dep-merge-gate.ts";
import type { GovernorStore } from "./govdb.ts";

export type ExecutorCvRow = { cv: number; valid: number; invalid: number };

// per-sid executor-class join, three existing surfaces, first hit wins:
// lane.<sid>.model fact, lane.<sid>.executor fact, then the sid's
// lane_launch_intents row (executor bin + host). Unresolvable sids
// contribute nothing — never a guessed class.
type LaneJoin = { cls: string; host: string | null };

export const cvKey = (host: string, cls: string): string =>
	`executor.${host}.${cls}.cv`;

const allIntents = (
	store: GovernorStore,
): { sid: string; executor: string; host: string | null }[] => {
	try {
		return store
			.query("SELECT sid, executor, host FROM lane_launch_intents")
			.all() as { sid: string; executor: string; host: string | null }[];
	} catch {
		return []; // table not migrated yet — no intent rows to join
	}
};

const laneJoin = (store: GovernorStore): Map<string, LaneJoin> => {
	const join = new Map<string, LaneJoin>();
	const put = (sid: string, patch: Partial<LaneJoin>): void => {
		const cur = join.get(sid) ?? { cls: "", host: null };
		join.set(sid, { ...cur, ...patch });
	};
	// facts may carry dots (llm:mac.local:glm) — parse from the full key
	for (const r of store
		.query(
			"SELECT key, value FROM facts WHERE key LIKE 'lane.%.model' OR key LIKE 'lane.%.executor'",
		)
		.all() as { key: string; value: string }[]) {
		const m = /^lane\.(.+)\.(model|executor)$/.exec(r.key);
		const sid = m?.[1];
		if (!sid) continue;
		put(sid, { cls: r.value });
	}
	// intent rows fill the executor-bin class and the host; a later row for
	// the same sid wins (one lane may have worked several items)
	for (const r of allIntents(store)) {
		if (r.sid && r.executor)
			put(r.sid, {
				cls: join.get(r.sid)?.cls || r.executor,
				host: r.host ?? null,
			});
	}
	return join;
};

/** The fold: replay the work bus chronologically (all projects — trust is
 * fleet-wide), attribute each claim segment to its claimant's class, count
 * consecutive-valid. Attribution rides the open claim (work.claimed `by`);
 * done/released/failed close it. Valid = done whose sha probes on-main
 * (true); pending or unknown sha reads "cannot know" — never a verdict.
 * Reclaim (operator-reclaim / reclaim-all) and fail zero the counter;
 * owner-release is reassignment, not an executor failure. */
export function executorCv(
	store: GovernorStore,
	opts: { host?: string } = {},
): Map<string, ExecutorCvRow> {
	const join = laneJoin(store);
	const open = new Map<string, string>(); // item → claimant sid
	const tally = new Map<string, ExecutorCvRow>();
	const row = (key: string): ExecutorCvRow => {
		let r = tally.get(key);
		if (!r) tally.set(key, (r = { cv: 0, valid: 0, invalid: 0 }));
		return r;
	};
	const rows = store
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') ORDER BY ts, id",
		)
		.all() as { id: number; ts: number; kind: string; payload: string | null }[];
	for (const r of rows) {
		let p: {
			work?: string;
			by?: string;
			sha?: string;
			reason?: string;
			project?: string;
		} = {};
		try {
			p = JSON.parse(r.payload ?? "{}");
		} catch {}
		if (!p.work) continue;
		if (r.kind === "work.claimed") {
			open.set(p.work, p.by ?? "");
			continue;
		}
		const sid = open.get(p.work);
		open.delete(p.work);
		const lane = sid ? join.get(sid) : undefined;
		if (!sid || !lane?.cls) continue; // unattributable — never a guessed class
		const key = cvKey(lane.host ?? opts.host ?? hostname(), lane.cls);
		if (r.kind === "work.failed") {
			row(key).cv = 0;
			row(key).invalid++;
			continue;
		}
		if (r.kind === "work.released") {
			if (p.reason === "owner-release") continue;
			row(key).cv = 0;
			row(key).invalid++;
			continue;
		}
		// work.done: a validated result needs a sha the ancestry probe confirms
		const verdict = p.sha ? shaOnMain(p.sha, p.project ?? "") : null;
		if (verdict !== true) continue; // pending or unknown — never a verdict
		const t = row(key);
		t.cv++;
		t.valid++;
	}
	return tally;
}

/** Pick-time lookup: this host's classes from the written facts. */
export const cvMap = (
	store: GovernorStore,
	host = hostname(),
): Map<string, number> =>
	new Map(
		(
			store
				.query("SELECT key, value FROM facts WHERE key LIKE ?")
				.all(`executor.${host}.%.cv`) as { key: string; value: string }[]
		).map((r) => {
			const prefix = `executor.${host}.`;
			const cls = r.key.slice(prefix.length, -".cv".length);
			return [cls, Number(r.value) || 0];
		}),
	);

/** Bank the tally as facts (source executor-cv), the measure the DEFAULT
 * ladder reorder reads. */
export const writeExecutorCvFacts = (
	store: GovernorStore,
	tally: Map<string, ExecutorCvRow>,
): number => {
	const now = Date.now();
	let n = 0;
	for (const [key, t] of tally) {
		store
			.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'executor-cv', 1, ?)",
			)
			.run(key, String(t.cv), now);
		n++;
	}
	return n;
};

/** Dispatch-side stamp: facts lane.<sid>.executor / .model at launch, the
 * join keys future folds attribute by (W105 parity with the board path). */
export const recordLaneExecutor = (
	store: GovernorStore,
	sid: string,
	executor: string,
	model: string | null,
): void => {
	const now = Date.now();
	const rows: [string, string][] = [["executor", executor]];
	if (model) rows.push(["model", model]);
	for (const [k, v] of rows)
		store
			.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
			)
			.run(`lane.${sid}.${k}`, v, now);
};
