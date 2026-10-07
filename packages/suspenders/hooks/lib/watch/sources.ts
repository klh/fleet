// hooks/lib/watch/sources.ts — W522 fleet-watch inputs: the three sanctioned
// read faces, one snapshot per tick. NO direct governor.db access here —
// `work lanes --json` + `coord fleet --json` are spawned per tick (the CLIs
// are the coord read face), the board feed is one HTTP GET. Merge is pure
// (mergeLanes) and unit-tested hermetically; the IO collectors are thin and
// env-overridable (config-over-code: FLEET_WATCH_BOARD / FLEET_WATCH_FLEET).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalProjectRoot } from "../lane-registry.ts";

export interface CoordLane {
	sid: string;
	name: string | null;
	intent: string | null;
	state: string;
}
export interface CoordFleet {
	head: string | null;
	lanes: CoordLane[];
}
export interface WorkLane {
	sid: string;
	item: string;
	live: boolean;
	host: string | null;
}
export interface BoardTask {
	project: string;
	id: string;
	title: string;
	state: string;
	owner_sid: string | null;
	owner_label: string | null;
	age_s: number;
	tag: string | null;
	tag_color: string | null;
	model: string | null;
	locality: string | null;
}
export interface LaneRow {
	sid: string;
	name: string | null;
	intent: string | null;
	state: string;
	live: boolean | null; // null = not in the .fleet registry (host/remote lane)
	item: string | null;
	itemState: string | null;
	ageS: number | null;
	tagColor: string | null;
	title: string | null;
}

/** Union the coord-fleet projection with the .fleet registry liveness and
 *  the board task rows. Lanes missing from either feed degrade per-field —
 *  a board outage never blanks a lane, a registry miss never blanks a state. */
export function mergeLanes(
	coord: CoordFleet | null,
	workLanes: WorkLane[] | null,
	tasks: BoardTask[],
): LaneRow[] {
	const taskById = new Map<string, BoardTask>();
	for (const t of tasks) if (t && typeof t.id === "string") taskById.set(t.id, t);
	const laneOf = new Map<string, WorkLane>();
	for (const l of workLanes ?? []) laneOf.set(l.sid, l);
	// registry sids run longer than coord's (`autow522` vs
	// `autow522-p98b319584008df14`) — join on prefix, either direction
	const laneFor = (sid: string): WorkLane | undefined => {
		const exact = laneOf.get(sid);
		if (exact) return exact;
		for (const [rsid, wl] of laneOf)
			if (rsid.startsWith(`${sid}-`) || sid.startsWith(`${rsid}-`))
				return wl;
		return undefined;
	};
	const out = new Map<string, LaneRow>();
	const push = (sid: string): LaneRow => {
		const wl = laneFor(sid);
		const t = wl ? taskById.get(wl.item) : undefined;
		const coordLane = coord?.lanes.find((c) => c.sid === sid);
		const row: LaneRow = {
			sid,
			name: coordLane?.name ?? null,
			intent: coordLane?.intent ?? null,
			state: coordLane?.state ?? "RUNNING",
			live: wl ? wl.live : null,
			item: wl?.item ?? null,
			itemState: t?.state ?? null,
			ageS: t?.age_s ?? null,
			tagColor: t?.tag_color ?? null,
			title: t?.title ?? null,
		 };
		out.set(sid, row);
		return row;
	};
	for (const c of coord?.lanes ?? []) push(c.sid);
	for (const wl of workLanes ?? []) {
		// the same lane may already sit in `out` under a short/long sid
		// variant — prefix-aware skip, not just exact-key
		const dup = [...out.keys()].some(
			(k) =>
				k === wl.sid ||
				wl.sid.startsWith(`${k}-`) ||
				k.startsWith(`${wl.sid}-`),
		);
		if (!dup) push(wl.sid);
	}
	return [...out.values()];
}

// ─── IO collectors (thin, env-overridable) ──────────────────────────────────

const PKG = join(import.meta.dir, "..", "..", ".."); // watch → package root
const asJson = (p: Bun.SyncSubprocess, what: string): unknown | null => {
	if (!p.success) return null;
	try {
		return JSON.parse(new TextDecoder().decode(p.stdout));
	} catch {
		console.error(`fleet-watch: unparsable ${what} output`);
		return null;
	}
};

/** Spawn the in-repo CLI (bun <pkg>/hooks/bin/<bin>.ts) with a hard timeout.
 *  Env overrides swap the binary path (FLEET_WATCH_WORK_BIN / _COORD_BIN). */
export function collectCli(
	bin: "work.ts" | "coord.ts",
	args: string[],
	envName: string,
): unknown | null {
	const path =
		process.env[envName] ?? join(PKG, "hooks", "bin", bin);
	return asJson(
		Bun.spawnSync([process.execPath, path, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 2000,
		}),
		bin,
	);
}

export const collectCoordFleet = (): CoordFleet | null =>
	collectCli("coord.ts", ["fleet", "--json"], "FLEET_WATCH_COORD_BIN") as
		| CoordFleet
		| null;

// work lanes: the registry audit is a ~9s spawn (per-lane transcript
// liveness probes) — the SLOW source. Resident single-flight cache, 30s
// TTL, refreshed via ASYNC spawn so the 1s tick never blocks; the frame
// shows last-good rows while a refresh runs (live marks degrade to null).
const WL_TTL = 30_000;
let wlCache: { at: number; lanes: WorkLane[] } | null = null;
let wlInFlight: Promise<WorkLane[] | null> | null = null;

const refreshWorkLanes = async (): Promise<WorkLane[] | null> => {
	const proc = Bun.spawn({
		cmd: [
			process.execPath,
			process.env.FLEET_WATCH_WORK_BIN ??
				join(PKG, "hooks", "bin", "work.ts"),
			"lanes",
			"--json",
		],
		stdout: "pipe",
		stderr: "ignore",
	});
	const kill = setTimeout(() => proc.kill(), 25_000);
	try {
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return asJsonLike(out, "work.ts");
	} finally {
		clearTimeout(kill);
		wlInFlight = null;
	}
};

const asJsonLike = (out: string, what: string): unknown | null => {
	try {
		return JSON.parse(out);
	} catch {
		console.error(`fleet-watch: unparsable ${what} output`);
		return null;
	}
};

/** Last-good `work lanes --json` rows — cached (30s TTL); a stale cache
 *  kicks exactly one async refresh (single-flight) and returns the cache. */
export function collectWorkLanes(): WorkLane[] | null {
	if (wlCache && Date.now() - wlCache.at < WL_TTL) return wlCache.lanes;
	if (!wlInFlight) {
		wlInFlight = refreshWorkLanes()
			.then((lanes) => {
				if (lanes) wlCache = { at: Date.now(), lanes };
				return lanes;
			})
			.catch(() => null);
	}
	return wlCache?.lanes ?? null;
}

/** The board /api/tasks feed — pass the board ORIGIN; the endpoint path is
 *  appended. null on outage; the frame degrades, the loop keeps ticking.
 *  Default loopback (W264 guard passes loopback Hosts). */
export async function collectBoardTasks(
	url: string,
): Promise<{ tasks: BoardTask[]; ms: number } | null> {
	const t0 = Date.now();
	const feed = `${url.replace(/\/+$/, "")}/api/tasks`;
	try {
		const r = await fetch(feed, {
			signal: AbortSignal.timeout(1500),
		});
		if (!r.ok) return null;
		const j = (await r.json()) as { tasks?: BoardTask[] };
		return j.tasks
			? { tasks: j.tasks, ms: Date.now() - t0 }
			: null;
	} catch (e) {
		console.error(`fleet-watch: board feed failed: ${String(e).slice(0, 120)}`);
		return null;
	}
}

/** Registry root for the footer — the fleet primary checkout as seen from
 *  cwd (worktree-aware via canonicalProjectRoot); FLEET_WATCH_FLEET env wins.
 *  Display only; `work lanes` resolves its own registry the same way. */
export function fleetRootLabel(): string {
	const env = process.env.FLEET_WATCH_FLEET;
	if (env) return env;
	return existsSync(join(process.cwd(), ".fleet", "lanes.json"))
		? process.cwd()
		: canonicalProjectRoot(process.cwd());
}
