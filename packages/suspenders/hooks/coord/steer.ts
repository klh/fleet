// hooks/coord/steer.ts — W1035: `coord steer <sid|label> "input"` — steer a
// RUNNING lane mid-turn. The input rides the ONE directed-event seam (the
// durable W303 inbox the lane's subscribe face already serves): the lane's
// managed runtime interrupts the in-flight turn and injects it, and lanes
// that cannot take stdin input still get the durable row via the push-gate
// drain — the inbox IS the fallback transport.
//
// Ack semantics (response.steer shape): accepted (queued), pending (lane
// mid-tool), failed (lane dead). Gates: one steer per sid per hour (W947
// dedupe window), the scrub ruleset (never steer with secrets), and the
// .fleet/steer-paused kill switch. --decide is the advisory kev decider
// (steer / redo / let-ride; deterministic overrides first).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
} from "../lib/lane-registry.ts";
import { laneVerdict, type LaneRef } from "../lib/lane-liveness.ts";
import { scanLine, scrubRules } from "../lib/scrub.ts";
import {
	ackFor,
	logReadOf,
	STEER_PAUSE_FILE,
	STEER_WINDOW_MS,
} from "../lib/steer-decision.ts";
import { reportSteerDecision } from "./steer-decide.ts";
import { emitEvent, queueDirectedReceipt } from "./bus.ts";
import { DIRECT_MESSAGE_KIND, resolveMessageTarget } from "./addressing.ts";
import { amber, arg, db, die, dim, green, red } from "./shared.ts";

type SteerLane = LaneRef & { attempt?: number; agent?: string };

/** Facts-ledger rate gate: one steer per sid per hour (W947 window). A steer
 *  that never emitted (failed on liveness) never consumed the budget. */
function steerRateLimited(sid: string, now = Date.now()): boolean {
	const prev = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.steer.at`) as { value: string } | null;
	const at = Number(prev?.value ?? 0);
	return now - at < STEER_WINDOW_MS;
}

function stampSteerFact(sid: string, now = Date.now()): void {
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(`lane.${sid}.steer.at`, String(now), "coord steer", now);
}

function emitSteer(sid: string, text: string, source: string): number {
	const id = emitEvent({
		kind: DIRECT_MESSAGE_KIND,
		note: text,
		source,
		to: sid,
	});
	queueDirectedReceipt(id, sid);
	return id;
}

/** W1035: `coord steer <sid|label> "input" [--as sid]` — the ack verb.
 *  Gates fire before any emit: kill switch, secrets scan, liveness, rate
 *  limit; a refused steer never queues an event nor consumes the budget. */
export async function cmdSteer(rest: string[]): Promise<void> {
	const source = arg("--as") ?? "coordinator";
	const decide = rest.includes("--decide");
	const targetNeedle = rest[0];
	const text = rest[1];
	if (!targetNeedle || (!decide && !text))
		die(
			'usage: steer <sid|label> "input" [--as sid] | steer <sid|label> --decide',
		);
	const root = canonicalProjectRoot(process.cwd());
	const { target, deferred } = resolveMessageTarget(targetNeedle);
	if (decide) {
		await reportSteerDecision(root, target.sid);
		return;
	}
	if (existsSync(join(root, ".fleet", STEER_PAUSE_FILE)))
		die(`steering paused — .fleet/${STEER_PAUSE_FILE} kill switch is set`);
	const hits = scanLine(text, scrubRules());
	if (hits.length)
		die(
			`steer refused — input trips the scrub ruleset (${hits
				.map((h) => `${h.rule}: ${h.match}`)
				.join("; ")}) — never steer with secrets`,
		);
	const row = loadLaneRegistry<SteerLane>(root).find(
		(l) => l.sid === target.sid,
	);
	const verdict = row ? laneVerdict(row) : "unknown";
	if (verdict !== "alive") {
		console.log(
			`${red("✖")} steer failed → @${target.sid.slice(0, 8)} — lane not provably live (probe ${verdict}); redo is the honest path`,
		);
		process.exitCode = 1;
		return;
	}
	if (steerRateLimited(target.sid)) {
		console.log(
			`${red("✖")} steer rate-limited → @${target.sid.slice(0, 8)} — one steer per sid per hour`,
		);
		process.exitCode = 1;
		return;
	}
	const { phase } = logReadOf(root, target.sid);
	const id = emitSteer(target.sid, text, source);
	stampSteerFact(target.sid);
	const ack = ackFor("alive", phase);
	if (ack === "pending")
		console.log(
			`${amber("●")} steer pending → @${target.sid.slice(0, 8)} (#${id}) — lane mid-tool; input queued, injects at the next input boundary`,
		);
	else
		console.log(
			`${green("✓")} steer accepted → @${target.sid.slice(0, 8)} (#${id}) — queued; the lane's runtime interrupts and injects mid-turn (log phase ${phase})`,
		);
	if (deferred)
		console.log(
			dim(
				"note: the exact sid is inactive — the steer stays queued until it resumes",
			),
		);
}
