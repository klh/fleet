// lane-death-capture.ts — W761: lane output was destroyed at death (the
// per-lane log outlived nothing useful and no verdict was banked), so every
// childless lane died a mystery. At prune time the log tail and the lane's
// lifetime are banked as facts the intent verb, the grinder breaker, and
// humans can read. Best-effort: a dark store never blocks a prune.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { GovernorStore } from "../../hooks/lib/govdb.ts";

export const OUTPUT_TAIL_BYTES = 4096;
/** the breaker window: ≥ MIN fresh samples, > RATIO sub-minute deaths → trip. */
export const GRINDER_MIN_SAMPLES = 4;
export const GRINDER_RATIO = 0.5;
export const SUB_MINUTE_MS = 60_000;
export const GRINDER_WINDOW_MS = 30 * 60_000;

/** Last `bytes` of a file as utf8; missing/empty/unreadable → "". */
export const logTail = (path: string, bytes = OUTPUT_TAIL_BYTES): string => {
	try {
		const size = statSync(path).size;
		if (size === 0) return "";
		const start = Math.max(0, size - bytes);
		const len = size - start;
		const buf = Buffer.alloc(len);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buf, 0, len, start);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
};

export type DeathRow = {
	sid: string;
	item?: string;
	launchedAt?: number;
};

/** Bank `lane.<sid>.death` facts ({item, livedMs, tail}) for pruned rows. */
export const captureLaneDeaths = (
	store: GovernorStore,
	fleet: string,
	removed: DeathRow[],
	now: number,
): void => {
	for (const r of removed) {
		const tail = logTail(`${fleet}/lane-${r.sid}.log`);
		const livedMs = r.launchedAt ? Math.max(0, now - r.launchedAt) : null;
		try {
			store
				.query(
					"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'dispatch',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=version+1,ts=excluded.ts",
				)
				.run(
					`lane.${r.sid}.death`,
					JSON.stringify({ item: r.item ?? null, livedMs, tail }),
					now,
				);
		} catch {
			// one dark row never blocks the rest
		}
	}
};

export type Grinder = {
	tripped: boolean;
	samples: number;
	subMinute: number;
};

/** Pure breaker read: recent (in-window) death facts decide. */
export const grinderVerdict = (
	rows: Array<{ value: string; ts: number }>,
	now: number = Date.now(),
): Grinder => {
	let samples = 0;
	let subMinute = 0;
	for (const r of rows.slice(0, 12)) {
		if (now - r.ts > GRINDER_WINDOW_MS) continue;
		try {
			const j = JSON.parse(r.value) as { livedMs?: number | null };
			if (typeof j.livedMs !== "number") continue;
			samples += 1;
			if (j.livedMs < SUB_MINUTE_MS) subMinute += 1;
		} catch {
			// unreadable fact rows don't count as samples
		}
	}
	return {
		tripped:
			samples >= GRINDER_MIN_SAMPLES && subMinute / samples > GRINDER_RATIO,
		samples,
		subMinute,
	};
};

/** The dispatch-side gate: read, maintain the once-only NEED_DECISION flag
 *  (cleared whenever the breaker untrips), report the verdict. */
export const grinderGate = (
	store: GovernorStore,
	emit: (note: string) => void,
): Grinder => {
	const rows = store
		.query(
			"SELECT value, ts FROM facts WHERE key LIKE 'lane.%.death' ORDER BY ts DESC LIMIT 12",
		)
		.all() as Array<{ value: string; ts: number }>;
	const g = grinderVerdict(rows);
	if (!g.tripped) {
		store.query("DELETE FROM facts WHERE key='dispatch.grinder-flagged'").run();
		return g;
	}
	const flagged = store
		.query("SELECT value FROM facts WHERE key=?")
		.get("dispatch.grinder-flagged");
	if (!flagged) {
		store
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES ('dispatch.grinder-flagged',?,'dispatch',1,?)",
			)
			.run(new Date().toISOString(), Date.now());
		emit(
			`grinder detected: ${g.subMinute}/${g.samples} recent lane deaths were sub-minute — launches refused until deaths age out of the 30-min window (W761 breaker)`,
		);
	}
	return g;
};
