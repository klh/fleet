// posture.admission.ts — W1315.3: shared admission over the resolved
// posture (the design's "separate admission step"). Selection stays pure
// (posture.policy.ts); this file combines it with live occupancy: the
// (hub, model) pool is SHARED physical capacity, so the ceiling count
// covers running AND reserved lanes across ALL projects, and the occupancy
// read + claim write ride ONE store transaction so two concurrent
// dispatchers cannot double-book a ceiling.
import type { GovernorStore } from "../govdb/govdb.ts";
import type { StackConfig } from "../stack-config.ts";
import {
	PostureDocumentSchema,
	type PostureDocument,
	type ResolvedEntry,
	type ResolvedPosture,
} from "./posture.zod.ts";
import { selectPostureEntries } from "./posture.policy.ts";
import { resolvePosture } from "./posture.resolve.ts";
import { readPostureLayers } from "./posture.prefer.ts";

/** The dispatch trace fact: lane.<sid>.entry = "<hub>\u0000<model>" — the
 *  shared-policy attribution joining live lanes to their posture entry. */
export const ENTRY_FACT = "entry";

export const entryKey = (entry: { hub: string; model: string }): string =>
	`${entry.hub}\u0000${entry.model}`;

/** The machine conf's posture document — null when no posture is configured
 *  (legacy steady/plaid behavior stays for the W1315.6 rollout). Malformed
 *  configuration throws loud (design: error, never silent fallback). */
export function stackPostureDocument(
	stack: StackConfig | null,
): PostureDocument | null {
	const raw = stack?.postures;
	if (!raw) return null;
	const parsed = PostureDocumentSchema.safeParse(raw);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
			.join("; ");
		throw new Error(`stack.json postures: ${details}`);
	}
	return parsed.data;
}

/** resolvePosture over the machine conf base + the repo path's .prefer
 *  layers. Null = no posture configured. */
export function resolveDispatchPosture(
	stack: StackConfig | null,
	dir: string,
): ResolvedPosture | null {
	const base = stackPostureDocument(stack);
	if (!base) return null;
	return resolvePosture(base, readPostureLayers(dir));
}

/** An entry claim by a lane not yet in sessions/intents (this launch, or
 *  another dispatcher's mid-flight admission) still reserves capacity for
 *  this window. */
export const POSTURE_RESERVED_WINDOW_MS = 30 * 60_000;

/** Running (any project's RUNNING session) + reserved (a held launch
 *  intent, or a fresh admission claim) lanes holding an entry fact,
 *  counted per (hub, model). */
export function postureOccupancy(store: GovernorStore): Map<string, number> {
	const live = new Set<string>();
	for (const r of store
		.query("SELECT sid FROM sessions WHERE state='RUNNING'")
		.all() as { sid: string }[])
		live.add(r.sid);
	try {
		for (const r of store
			.query("SELECT sid FROM lane_launch_intents")
			.all() as { sid: string }[])
			live.add(r.sid);
	} catch {} // pre-intents db — no reserved evidence
	const now = Date.now();
	const occupancy = new Map<string, number>();
	for (const r of store
		.query("SELECT key, value, ts FROM facts WHERE key GLOB 'lane.*.entry'")
		.all() as { key: string; value: string; ts: number }[]) {
		const sid = r.key.slice("lane.".length, -".entry".length);
		if (
			!live.has(sid) &&
			r.ts < now - POSTURE_RESERVED_WINDOW_MS
		)
			continue;
		occupancy.set(r.value, (occupancy.get(r.value) ?? 0) + 1);
	}
	return occupancy;
}

/** Stamp the dispatch trace: the admitted entry, source 'dispatch'. */
export function recordPostureEntry(
	store: GovernorStore,
	sid: string,
	entry: { hub: string; model: string },
): void {
	store
		.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		)
		.run(`lane.${sid}.${ENTRY_FACT}`, entryKey(entry), Date.now());
}

export type PostureAdmission =
	| { ok: true; entry: ResolvedEntry }
	| { ok: false; reason: string };

/** One launch admission: select eligible entries (policy + usable holds),
 *  then — inside ONE transaction — re-read occupancy and claim the first
 *  entry with headroom under its shared ceiling. lanes "MAX" has no
 *  configured ceiling; a number is a concurrent-lane ceiling. NO unlisted
 *  fallback: exhausting every eligible entry blocks with the reason. */
export function admitPostureLaunch(o: {
	store: GovernorStore;
	resolved: ResolvedPosture;
	sid: string;
	/** health/quota holds — an entry failing this is never eligible. */
	usable?: (entry: ResolvedEntry) => boolean;
}): PostureAdmission {
	const eligible = selectPostureEntries(o.resolved, (e) =>
		o.usable ? o.usable(e) : true,
	);
	if (!eligible.length)
		return {
			ok: false,
			reason:
				"posture: no usable entry — every enabled entry is held (health/quota) or disabled",
		};
	return o.store.transaction(() => {
		const occupancy = postureOccupancy(o.store);
		for (const entry of eligible) {
			if (
				entry.lanes !== "MAX" &&
				(occupancy.get(entryKey(entry)) ?? 0) >= entry.lanes
			)
				continue;
			recordPostureEntry(o.store, o.sid, entry);
			return { ok: true, entry };
		}
		const ceilingOf = (e: ResolvedEntry): string =>
			e.lanes === "MAX" ? "MAX" : String(e.lanes);
		return {
			ok: false,
			reason: `posture: shared hub/model ceilings exhausted — ${eligible
				.map(
					(e) =>
						`${e.hub}/${e.model} ${occupancy.get(entryKey(e)) ?? 0}/${ceilingOf(e)}`,
				)
				.join(", ")} (running+reserved, all projects); no unlisted fallback`,
		};
	})();
}
