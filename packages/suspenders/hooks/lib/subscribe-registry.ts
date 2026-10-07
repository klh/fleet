// subscribe-registry.ts — W417.3: the lane-subscribe lifecycle. `coord
// subscribe --as sid` registers its pid here (fact lane.<sid>.subscribe,
// stamped with the host so only the owning machine ever signals it); `work
// done`/release/reclaim reap the subscriber the moment its lane's work goes
// terminal, and `coord gc` sweeps subscribers whose lane transcript went
// stale. Best-effort acceleration of the W494 self-exit — the registry is
// never load-bearing: a lost or aged-out row just falls back to the 15-min
// transcript-staleness exit.
import { hostname } from "node:os";
import type { GovernorStore } from "./govdb.ts";
import { transcriptAlive } from "./lane-liveness.ts";

const THIS_HOST = hostname();

export type SubscribeReap = "absent" | "unregistered" | "kept" | "signalled";

export interface SubscribeSweep {
	checked: number;
	signalled: number;
	unregistered: number;
}

const subscribeKey = (sid: string): string => `lane.${sid}.subscribe`;

interface SubscribeReg {
	pid: number;
	host?: string;
	startedAt?: number;
}

export function registerSubscribe(
	store: GovernorStore,
	sid: string,
	pid: number,
): void {
	store.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(
		subscribeKey(sid),
		JSON.stringify({ pid, host: THIS_HOST, startedAt: Date.now() }),
		sid,
		Date.now(),
	);
}

export function unregisterSubscribe(store: GovernorStore, sid: string): void {
	store.query("DELETE FROM facts WHERE key = ?").run(subscribeKey(sid));
}

// anchored sid reference in ps args — a recycled pid running an unrelated
// command never matches (same args-roster discipline as lane-liveness W309)
function argsReferenceSid(args: string, sid: string): boolean {
	const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`,
	).test(args);
}

export function reapSubscribe(
	store: GovernorStore,
	sid: string,
	opts: { staleOnly?: boolean } = {},
): SubscribeReap {
	const row = store
		.query("SELECT value FROM facts WHERE key = ?")
		.get(subscribeKey(sid)) as { value: string } | null | undefined;
	if (!row) return "absent";
	let reg: SubscribeReg | null = null;
	try {
		reg = JSON.parse(row.value) as SubscribeReg;
	} catch {}
	if (
		!reg ||
		typeof reg !== "object" ||
		!Number.isSafeInteger(reg.pid) ||
		reg.pid < 1
	)
		return dropSubscribe(store, sid);
	if (reg.host && reg.host !== THIS_HOST) return "kept"; // its host reaps it
	const ps = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (ps.exitCode !== 0) return "kept"; // no process table, no kill — retry next pass
	const line = ps.stdout
		.toString()
		.split("\n")
		.find((l) => Number.parseInt(l.trim(), 10) === reg?.pid);
	if (!line) return dropSubscribe(store, sid); // process gone — stale row
	if (!argsReferenceSid(line.replace(/^\s*\d+\s+/, ""), sid))
		return dropSubscribe(store, sid); // recycled pid runs someone else now
	if (opts.staleOnly && transcriptAlive(sid)) return "kept"; // lane working
	try {
		process.kill(reg.pid, "SIGTERM");
	} catch {}
	unregisterSubscribe(store, sid);
	return "signalled";
}

function dropSubscribe(store: GovernorStore, sid: string): SubscribeReap {
	unregisterSubscribe(store, sid);
	return "unregistered";
}

// item went terminal via done/release/reclaim: reap the owner's lane
// subscribe when the sid owns no other active work (lane lifecycle = owns
// work). Identity-checked; best-effort, never fatal.
export function reapOwnerSubscribe(
	store: GovernorStore,
	owner: string | null | undefined,
): SubscribeReap {
	if (!owner) return "absent";
	const active = store
		.query(
			"SELECT 1 FROM work_items WHERE owner_sid = ? AND state IN ('CLAIMED','RUNNING','ORPHANED') LIMIT 1",
		)
		.get(owner);
	if (active) return "kept";
	return reapSubscribe(store, owner);
}

// gc sweep — transcript-stale subscribers only; runs db.local (processes are
// host-local: foreign-host rows are skipped via the host stamp inside
// reapSubscribe and age out with the ordinary lane.% fact retention)
export function sweepSubscribes(store: GovernorStore): SubscribeSweep {
	const rows = store
		.query("SELECT key FROM facts WHERE key LIKE 'lane.%.subscribe'")
		.all() as { key: string }[];
	const out: SubscribeSweep = {
		checked: rows.length,
		signalled: 0,
		unregistered: 0,
	};
	for (const r of rows) {
		const sid = r.key.slice("lane.".length, -".subscribe".length);
		if (!sid) continue;
		const v = reapSubscribe(store, sid, { staleOnly: true });
		if (v === "signalled") out.signalled++;
		else if (v === "unregistered") out.unregistered++;
	}
	return out;
}
