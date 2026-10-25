// hooks/coord/coordination.ts — W977.1 `coord coordinate`: the bounded
// supervisor coordination round. Validates topic/note, runs the outbound
// Kev gate (--classify), enforces singleflight + rate-cap bounds, then fans
// one OPEN consult per live peer with the asker's state snapshot in the
// payload. Answers ride the standard consult-reply flow; the asker's
// bounded wait face is `coord wait --kinds consult.answer`.
import { consultDeadline } from "../lib/federation/consult-expiry.ts";
import { claimedWorkOf } from "../lib/lanes/lane-effort.ts";
import {
	ensureConsultFederation,
	mintTraceId,
} from "../lib/federation/consult-federation.ts";
import {
	type AskerSnapshot,
	COORD_TOPICS,
	type CoordTopic,
	askerSnapshot,
	coordBounds,
	coordinationGate,
	livePeers,
	openRound,
	questionFor,
	roundsInWindow,
} from "../lib/lanes/supervisor-coordination.ts";
import { arg, db, die, projectIdentity } from "./shared.ts";
import { queueDirectedReceipt } from "./bus.ts";

const USAGE =
	'usage: coordinate --topic work|claims|capacity --note "..." [--max-peers n] [--classify] [--json] --as <sid>';

const KNOWN_FLAGS = [
	"--as",
	"--topic",
	"--note",
	"--max-peers",
	"--json",
	"--classify",
];

interface CoordinateArgs {
	as: string;
	topic: CoordTopic;
	note: string;
	maxPeers: number;
	json: boolean;
	classify: boolean;
}

export function parseCoordinateArgs(rest: string[]): CoordinateArgs {
	const as = arg("--as");
	if (!as) die(USAGE);
	const topic = arg("--topic") as CoordTopic | null;
	if (!topic || !(COORD_TOPICS as readonly string[]).includes(topic))
		die(USAGE);
	const note = (arg("--note") ?? "").trim().slice(0, 2000);
	if (!note) die(USAGE);
	for (const t of rest) {
		if (t.startsWith("--") && !KNOWN_FLAGS.includes(t))
			die(`unknown option: ${t}`);
	}
	const bounds = coordBounds();
	// an explicit 0 means 0 (a dry-run/no-peer round); absent/NaN falls to
	// bounds — arg() is null when the flag is absent and Number(null) === 0,
	// so the null check comes FIRST
	const raw = arg("--max-peers");
	const mp = raw == null || raw === "" ? NaN : Number(raw);
	const maxPeers = Number.isFinite(mp) && mp >= 0 ? mp : bounds.maxPeers;
	return {
		as,
		topic,
		note,
		maxPeers,
		json: rest.includes("--json"),
		classify: rest.includes("--classify"),
	};
}

interface MintedRound {
	consults: string[];
	peers: string[];
	snapshot: AskerSnapshot;
}

function mintRound(a: CoordinateArgs, project: string): MintedRound | null {
	const snapshot = askerSnapshot(db, project, a.as);
	// singleflight first: a replay is idempotent and never consumes the cap
	const open = openRound(db, project, a.as, a.topic);
	if (open) return { consults: [`C${open.id}`], peers: [], snapshot };
	const bounds = coordBounds();
	if (roundsInWindow(db, project, a.as, bounds.rateWindowMs) >= bounds.rateMax)
		die(
			"coordination rate cap hit — wait for the window or raise SUSPENDERS_COORD_RATE_MAX",
		);
	const peers = livePeers(db, project, a.as, a.maxPeers);
	if (!peers.length) {
		// W923 parity: a refused round still events (the item link rides along)
		const refusedEvent = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', NULL, ?, ?)",
			)
			.run(
				Date.now(),
				a.as,
				JSON.stringify({
					state: "REFUSED",
					why: "no live peers",
					topic: a.topic,
				}),
				a.as,
			);
		queueDirectedReceipt(Number(refusedEvent.lastInsertRowid), a.as);
		die("no live peers — nobody RUNNING to coordinate with");
	}
	return {
		consults: mintConsults(a, project, snapshot, peers),
		peers: peers.map((p) => p.sid),
		snapshot,
	};
}

function mintConsults(
	a: CoordinateArgs,
	project: string,
	snapshot: AskerSnapshot,
	peers: { sid: string }[],
): string[] {
	ensureConsultFederation(db);
	const traceId = mintTraceId();
	const question = questionFor(a.topic, a.note);
	const deadline = consultDeadline(Date.now());
	const work = claimedWorkOf(db, project, a.as);
	const insert = db.query(
		"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at, deadline_at) VALUES (?, ?, ?, ?, NULL, 'OPEN', ?, ?)",
	);
	const stamp = db.query(
		"INSERT INTO consult_federation (consult_id, trace_id, idempotency_key, route, hub, state, created_at) VALUES (?, ?, ?, ?, NULL, 'OPEN', ?)",
	);
	const minted: string[] = [];
	for (const p of peers) {
		const r = insert.run(project, a.as, p.sid, question, Date.now(), deadline);
		const cid = `C${r.lastInsertRowid}`;
		stamp.run(
			Number(r.lastInsertRowid),
			traceId,
			`${traceId}:${p.sid}`,
			JSON.stringify([{ stage: "expert", at: Date.now() }]),
			Date.now(),
		);
		const payload = JSON.stringify({
			consult: cid,
			topic: a.topic,
			q: a.note,
			state: snapshot,
			project,
			...(work ? { work } : {}),
		});
		const questionEvent = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', NULL, ?, ?)",
			)
			.run(Date.now(), a.as, payload, p.sid);
		queueDirectedReceipt(Number(questionEvent.lastInsertRowid), p.sid);
		minted.push(cid);
	}
	return minted;
}

export async function cmdCoordinate(rest: string[]): Promise<void> {
	// a peer ask, not knowledge: kb/fact lookups stay OUT of the round path
	const a = parseCoordinateArgs(rest);
	const project = projectIdentity();
	const snapshot = askerSnapshot(db, project, a.as);
	const gate = await coordinationGate({
		topic: a.topic,
		note: a.note,
		snapshot,
		classify: a.classify,
	});
	if (!gate.fired) {
		const why = `SKIP topic=${a.topic} via=${gate.via}${gate.model ? ` model=${gate.model}` : ""}`;
		console.log(a.json ? JSON.stringify({ ok: true, fired: false, why }) : why);
		return;
	}
	const round = mintRound(a, project);
	const out = {
		ok: true,
		fired: true,
		via: gate.via,
		topic: a.topic,
		consults: round.consults,
		peers: round.peers,
		replay: round.peers.length === 0 && round.consults.length === 1,
		snapshot: round.snapshot,
	};
	console.log(
		a.json
			? JSON.stringify(out)
			: round.consults.map((c) => `${c} → topic=${a.topic}`).join("\n"),
	);
}
