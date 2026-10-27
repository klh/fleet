// hooks/coord/steer-decide.ts — W1035: the `--decide` face of coord steer.
// Item shape + W776 spend + lane posture in, one steer/redo/let-ride verdict
// out (lib/steer-decision.ts owns the kev pass + overrides). Read-only.
import type { Database } from "bun:sqlite";

import { type LaneRef, laneVerdict } from "../lib/lanes/lane-liveness.ts";
import { loadLaneRegistry } from "../lib/lanes/lane-registry.ts";
import { itemAttribution } from "../lib/lanes/lane-spend.ts";
import {
	decideSteerOrRedo,
	logReadOf,
	type SteerDecisionInput,
} from "../lib/steer-decision.ts";
import { db, dim, projectIdentity } from "./shared.ts";

type SteerLane = LaneRef & { attempt?: number; agent?: string };

type ItemRow = {
	id: string;
	title: string;
	description: string | null;
	state: string;
};

/** Render one advisory steer-vs-redo decision for a lane's target sid. */
export async function reportSteerDecision(
	root: string,
	sid: string,
): Promise<void> {
	const project = projectIdentity();
	const row = loadRow(root, sid);
	const itemRow = itemRowFor(project, row?.item, sid);
	const attr = itemAttribution(db as unknown as Database, project).get(
		itemRow?.id ?? "",
	);
	const log = logReadOf(root, sid);
	const input: SteerDecisionInput = {
		item: {
			id: itemRow?.id ?? "unknown",
			title: itemRow?.title ?? "unknown item",
			state: itemRow?.state ?? "UNKNOWN",
			description: itemRow?.description ?? null,
			attempt: row?.attempt,
		},
		lane: {
			verdict: row ? laneVerdict(row) : "unknown",
			phase: log.phase,
			logAgeMs: log.ageMs,
		},
		spend: {
			fresh: attr?.fresh ?? 0,
			cached: attr?.cached ?? 0,
			out: attr?.out ?? 0,
			agentMs: attr?.agentMs ?? 0,
		},
	};
	const decision = await decideSteerOrRedo(input, { timeoutMs: 60_000 });
	console.log(
		`steer-decision → @${sid.slice(0, 8)} item ${input.item.id}: ${decision.choice} (via ${decision.via}${decision.via === "kev" ? `, ${Math.round(decision.confidence * 100)}%` : ""})`,
	);
	const probs = Object.entries(decision.probabilities).sort(
		(a, b) => b[1] - a[1],
	);
	if (probs.length)
		console.log(
			`  ${probs.map(([label, v]) => `${label} ${Math.round(v * 100)}%`).join(" · ")}`,
		);
	console.log(dim(decision.rationale));
}

function loadRow(root: string, sid: string): SteerLane | undefined {
	return loadLaneRegistry<SteerLane>(root).find((l) => l.sid === sid);
}

function itemRowFor(
	project: string,
	item: string | undefined,
	sid: string,
): ItemRow | null {
	const byId = db
		.query(
			"SELECT id, title, description, state FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, item ?? "") as ItemRow | null;
	if (byId) return byId;
	return db
		.query(
			"SELECT id, title, description, state FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED') ORDER BY updated_at DESC LIMIT 1",
		)
		.get(project, sid) as ItemRow | null;
}
