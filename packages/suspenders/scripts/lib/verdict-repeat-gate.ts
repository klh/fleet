// verdict-repeat-gate.ts — W896: the dispatch/resume flip. dispatch-next.ts
// injects the plane's CLI helpers; this module owns the comparison (lib/
// verdict-repeat.ts) + the operator-gated close: FAILED + NEED_DECISION,
// verdict on the card via the fail note.
import {
	capsuleBankedAt,
	parseVerdictObservation,
	verdictOfCapsule,
	verdictRepeats,
} from "./verdict-repeat.ts";

type CliRun = (cmd: string[]) => { code: number; out: string };
type CliArgs = (...args: string[]) => string[];

/** The operator-gate line: the verdict repeats verbatim — stop retrying. */
export const verdictGateNote = (verdict: string): string =>
	`operator-gated (W896): lane closed twice on the same verdict — "${verdict}" — auto-retry stopped`;

interface GateIo {
	sid: string;
	run: CliRun;
	coordCli: CliArgs;
	workCli: CliArgs;
	log: (msg: string) => void;
}

/** The NEED_DECISION emit — the owner-facing decision surface. */
const emitDecision = (io: GateIo, note: string): void => {
	io.run(
		io.coordCli(
			"emit",
			"NEED_DECISION",
			"--as",
			io.sid,
			"--scope",
			"suspenders",
			"--note",
			note,
		),
	);
};

/** Bank this cycle's observation for the next cycle's comparison. */
const bankObservation = (
	io: GateIo,
	key: string,
	verdict: string,
	ts: number,
): void => {
	io.run(
		io.coordCli(
			"fact",
			"set",
			key,
			"--text",
			JSON.stringify({ verdict, ts }),
			"--source",
			"dispatch",
		),
	);
};

/** The stored observation read for the comparison. */
const readObservation = (io: GateIo, key: string) =>
	parseVerdictObservation(io.run(io.coordCli("fact", "get", key)).out);

/** THE dispatch/resume flip: read the capsule's closing verdict, compare
 *  with the observation banked at the last dispatch cycle, and on a verbatim
 *  repeat from a re-banked capsule flip the item to the operator-gated class
 *  — FAILED + NEED_DECISION, the verdict line surfaced on the card via the
 *  fail note — instead of another spawn. Returns true when gated. */
export function verdictRepeatGate(io: {
	item: string;
	sid: string;
	capsule: Record<string, unknown> | null;
	run: CliRun;
	coordCli: CliArgs;
	workCli: CliArgs;
	log: (msg: string) => void;
}): boolean {
	const key = `lane.${io.sid}.verdict-last`;
	const closed = verdictOfCapsule(io.capsule);
	const stored = readObservation(io, key);
	if (verdictRepeats(stored, closed, capsuleBankedAt(io.capsule))) {
		const note = verdictGateNote(stored?.verdict ?? closed);
		console.log(`STOP ${io.item} — ${note}`);
		io.log(`verdict-repeat ${io.item} → ${io.sid}`);
		io.run(io.coordCli("fact", "rm", key));
		const failed = io.run(
			io.workCli("fail", io.item, "--as", io.sid, "--note", note),
		);
		if (failed.code !== 0) throw new Error(failed.out);
		emitDecision(io, note);
		return true;
	}
	if (closed) bankObservation(io, key, closed, capsuleBankedAt(io.capsule));
	return false;
}
