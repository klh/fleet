// signals-scan.ts — W969 Signals-lite: per-run silent-failure scan of lane
// traces via the EXISTING oracle pinned leg (:8903). Pattern-lift from
// Laminar flow-1/Signals (owner GO 2026-10-20, finding.laminar-flow1): fleet
// lanes fail silently in exactly flow-1's target classes (W833 = the lane
// reported done while claim-check evidence contradicted; W967 = stall, 10.7
// min no-progress while riding). A fleet-loop maintenance runner (registry
// entry `signals-scan`, hooks/lib/fleet-loop/maintenance.ts owns cadence)
// scans lanes that closed work since the last fire: BOUNDED evidence
// (transcript TAIL + capsule + the work.done payload — never the full
// transcript) through a FIXED prompt contract; the parsed verdict emits a
// lane.signal event (the board lanes view surfaces it); non-clean findings
// append to the blam intake queue (~/.claude-insights/blam-signals.jsonl)
// for human curation into packages/blam/dataset — never a direct dataset
// append (the labeling protocol owns validation + sanitization).
// Oracle leg down or unparseable answer: the scan window holds and retries
// next fire, silently — never blocks lane close. SUSPENDERS_SIGNALS_SCAN=0
// disables (bin face).
import {
	appendFileSync,
	closeSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { itemCapsuleKey } from "./capsule-fence.ts";
import { emitLoopEvent } from "./fleet-loop/events.ts";
import type { GovernorStore } from "./govdb.ts";
import type { LegResult } from "./oracle-legs.ts";

export type SignalClass =
	| "reported-done-tests-red"
	| "loop-no-progress"
	| "claim-evidence-mismatch"
	| "clean";

export const SIGNAL_CLASSES: readonly SignalClass[] = [
	"reported-done-tests-red",
	"loop-no-progress",
	"claim-evidence-mismatch",
	"clean",
];

// The FIXED prompt contract (Signals-style, flow-1 pattern-lift): four
// classes, JSON-only verdict. Never free-form; the parser validates the
// class against SIGNAL_CLASSES and clamps confidence.
export const SIGNALS_FRAME = [
	"You are a read-only silent-failure scanner (oracle fixed contract).",
	"Evidence below is one closed lane run: completion claim + capsule + transcript tail.",
	"Question: did this lane report success while its evidence contradicts it?",
	"Classes:",
	"- reported-done-tests-red: reported done/success while evidence shows failing tests, failing checks, or errors it did not surface",
	"- loop-no-progress: the same action or answer repeats with no state change (stall loop)",
	"- claim-evidence-mismatch: the completion claim (sha/artifact/outcome) does not match the evidence",
	"- clean: no contradiction found",
	'Reply with ONLY the JSON verdict, no prose: {"class":"<class>","confidence":<0..1>,"evidence":"<one line why>"}',
].join("\n");

// bounded input: tail + capsule, never the full transcript
export const SIGNAL_TAIL_BYTES = 32 * 1024;
export const SIGNAL_MAX_BLOCKS = 24;
export const SIGNAL_EVIDENCE_CAP = 12_000;
export const SIGNAL_MAX_TOKENS = 500;
export const SIGNAL_TIMEOUT_MS = 90_000;
export const SIGNAL_BATCH_CAP = 8;
export const SIGNAL_MAX_ATTEMPTS = 3;
// blam intake queue — machine-local, mode 600; curation promotes rows into
// packages/blam/dataset via the labeling protocol
export const blamSignalsQueue = (): string =>
	process.env.BLAM_SIGNALS_QUEUE ??
	join(homedir(), ".claude-insights", "blam-signals.jsonl");

export interface SignalVerdict {
	cls: SignalClass;
	confidence: number;
	evidence: string;
}

/** Extract + validate the JSON verdict from a model reply. Null when the
 *  answer is not a parseable, in-vocabulary verdict (the caller holds the
 *  window and retries — a garbage answer never becomes an event). */
export function parseVerdict(text: string): SignalVerdict | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let j: unknown;
	try {
		j = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof j !== "object" || j === null) return null;
	const o = j as Record<string, unknown>;
	if (typeof o.class !== "string") return null;
	if (!SIGNAL_CLASSES.includes(o.class as SignalClass)) return null;
	const raw = typeof o.confidence === "number" ? o.confidence : 0.5;
	return {
		cls: o.class as SignalClass,
		confidence: Math.min(1, Math.max(0, raw)),
		evidence:
			typeof o.evidence === "string"
				? o.evidence.replace(/\s+/g, " ").trim().slice(0, 200)
				: "",
	};
}

const promptFor = (evidence: string): string =>
	`${SIGNALS_FRAME}\n\nEVIDENCE:\n${evidence.slice(0, SIGNAL_EVIDENCE_CAP)}`;

/** Bounded transcript tail: the last assistant text / tool_use blocks of a
 *  JSONL transcript, newest-last. Lib twin of the board's transcriptTailAll
 *  (board/lanes.ts rides the sessions db; this takes the path directly). */
export function transcriptEvidence(
	path: string,
	maxBlocks = SIGNAL_MAX_BLOCKS,
): string {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return "";
	}
	const start = Math.max(0, size - SIGNAL_TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	try {
		const fd = openSync(path, "r");
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
	} catch {
		return "";
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line may be a partial record
	const out: string[] = [];
	for (let i = lines.length - 1; i >= 0 && out.length < maxBlocks; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		let j: {
			message?: {
				role?: string;
				content?: {
					type?: string;
					text?: string;
					name?: string;
					input?: Record<string, unknown> | null;
				}[];
			};
		};
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = j?.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (
			let k = msg.content.length - 1;
			k >= 0 && out.length < maxBlocks;
			k--
		) {
			const b = msg.content[k];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
				out.push(`[text] ${b.text.trim().replace(/\s+/g, " ").slice(0, 300)}`);
			else if (b?.type === "tool_use" && b.name)
				out.push(
					`[tool] ${b.name}: ${String(
						b.input?.command ??
							b.input?.file_path ??
							b.input?.pattern ??
							b.input?.description ??
							"",
					)
						.replace(/\s+/g, " ")
						.slice(0, 260)}`,
				);
		}
	}
	return out.reverse().join("\n");
}

/** The bounded evidence bundle for one closed run: item claim + capsule +
 *  work.done payload + transcript tail. Every section fail-softs. */
export function buildEvidence(
	store: GovernorStore,
	project: string,
	item: string,
	sid: string | null,
): string {
	const parts: string[] = [];
	try {
		const w = store
			.query(
				"SELECT title, description, result_sha FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, item) as {
			title: string;
			description: string | null;
			result_sha: string | null;
		} | null;
		if (w)
			parts.push(
				`ITEM: ${item} — ${w.title}${w.result_sha ? ` (sha ${w.result_sha.slice(0, 12)})` : ""}`,
			);
		if (w?.description)
			parts.push(`DESCRIPTION: ${w.description.slice(0, 800)}`);
	} catch {}
	if (sid) {
		parts.push(`LANE: ${sid}`);
		try {
			const s = store
				.query("SELECT transcript_path FROM sessions WHERE sid = ?")
				.get(sid) as { transcript_path: string | null } | null;
			if (s?.transcript_path) {
				const tail = transcriptEvidence(s.transcript_path);
				if (tail !== "") parts.push(`TRANSCRIPT TAIL:\n${tail}`);
			}
		} catch {}
	}
	try {
		const c = store
			.query("SELECT value FROM facts WHERE key = ?")
			.get(itemCapsuleKey(project, item)) as { value: string } | null;
		if (c?.value) parts.push(`CAPSULE: ${c.value.slice(0, 2048)}`);
	} catch {}
	try {
		const d = store
			.query(
				"SELECT payload FROM events WHERE kind = 'work.done' AND project = ? AND work = ? ORDER BY id DESC LIMIT 1",
			)
			.get(project, item) as { payload: string | null } | null;
		if (d?.payload) parts.push(`DONE EVENT: ${d.payload.slice(0, 800)}`);
	} catch {}
	return parts.join("\n\n");
}

/** The closing lane of a done event: the newest work.claimed payload.by at
 *  or before the close (work done clears owner_sid; the claim is immutable). */
export function closingSid(
	store: GovernorStore,
	project: string,
	item: string,
	doneId: number,
): string | null {
	const rows = store
		.query(
			"SELECT payload FROM events WHERE kind = 'work.claimed' AND project = ? AND work = ? AND id <= ? ORDER BY id DESC LIMIT 1",
		)
		.all(project, item, doneId) as { payload: string | null }[];
	for (const r of rows) {
		try {
			const by = JSON.parse(r.payload ?? "{}") as { by?: unknown };
			if (typeof by.by === "string" && by.by !== "") return by.by;
		} catch {}
	}
	return null;
}

export interface ScanState {
	/** newest work.done event id fully resolved (scanned/skipped/given-up) */
	lastId: number;
	/** per-item scan attempts (leg down / unparseable) — capped */
	attempts: Record<string, number>;
	/** fully resolved items — never rescanned */
	done: Record<string, number>;
}

export function readScanState(path: string): ScanState {
	try {
		const j = JSON.parse(readFileSync(path, "utf8")) as Partial<ScanState>;
		return {
			lastId: typeof j.lastId === "number" ? j.lastId : 0,
			attempts: j.attempts ?? {},
			done: j.done ?? {},
		};
	} catch {
		return { lastId: 0, attempts: {}, done: {} };
	}
}

export function writeScanState(path: string, state: ScanState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	} catch {}
}

export interface ScanOutcome {
	/** items that produced a verdict this fire */
	scanned: { item: string; cls: SignalClass; confidence: number }[];
	/** non-clean verdicts appended to the blam intake queue */
	blamQueued: number;
	/** held back: leg down / unparseable (window holds, retries next fire) */
	held: number;
	/** skipped: no closing lane, no evidence, or attempt cap reached */
	skipped: number;
}

export interface SignalsScanDeps {
	repo: string;
	store: GovernorStore;
	statePath?: string;
	limit?: number;
	log?: (msg: string) => void;
	/** the oracle leg — injectable for tests; default = the pinned :8903 leg */
	leg?: (prompt: string) => Promise<LegResult>;
	now?: () => number;
}

export const defaultLeg = (prompt: string): Promise<LegResult> =>
	pinnedLeg(prompt, SIGNAL_MAX_TOKENS, SIGNAL_TIMEOUT_MS);

export const appendBlamQueue = (
	row: Record<string, unknown>,
	path = blamSignalsQueue(),
): boolean => {
	try {
		appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
};

/** ONE fire: scan the closed-lane window through the oracle leg. The window
 *  holds at the first leg/parse failure (retry next fire — never skip a
 *  verdict silently and never advance past it); skips (no lane, no evidence,
 *  cap reached) advance it. */
export function createSignalsScan(
	deps: SignalsScanDeps,
): () => Promise<ScanOutcome> {
	const statePath =
		deps.statePath ?? join(deps.repo, ".fleet", "signals-scan.json");
	const limit = deps.limit ?? SIGNAL_BATCH_CAP;
	const log = deps.log ?? (() => {});
	const leg = deps.leg ?? defaultLeg;
	const now = deps.now ?? (() => Date.now());
	return async (): Promise<ScanOutcome> => {
		const store = deps.store;
		const state = readScanState(statePath);
		const doneRows = store
			.query(
				"SELECT id, ts, project, work, payload FROM events WHERE kind = 'work.done' AND id > ? ORDER BY id LIMIT ?",
			)
			.all(state.lastId, limit) as {
			id: number;
			ts: number;
			project: string;
			work: string | null;
			payload: string | null;
		}[];
		const out: ScanOutcome = {
			scanned: [],
			blamQueued: 0,
			held: 0,
			skipped: 0,
		};
		for (const ev of doneRows) {
			if (ev.work === null || ev.work === "") {
				state.lastId = ev.id;
				continue;
			}
			const key = `${ev.project}\u0000${ev.work}`;
			if (state.done[key] !== undefined) {
				state.lastId = ev.id;
				continue;
			}
			if ((state.attempts[key] ?? 0) >= SIGNAL_MAX_ATTEMPTS) {
				state.done[key] = now();
				state.lastId = ev.id;
				out.skipped++;
				continue;
			}
			const sid = closingSid(store, ev.project, ev.work, ev.id);
			if (sid === null) {
				// auto-closed rollup or legacy row — no lane run to scan
				state.done[key] = now();
				state.lastId = ev.id;
				out.skipped++;
				continue;
			}
			const evidence = buildEvidence(store, ev.project, ev.work, sid);
			if (evidence.trim() === "") {
				state.done[key] = now();
				state.lastId = ev.id;
				out.skipped++;
				continue;
			}
			let text: string;
			try {
				text = (await leg(promptFor(evidence))).text;
			} catch (e) {
				// leg down: hold the window here, retry next fire, silently
				state.attempts[key] = (state.attempts[key] ?? 0) + 1;
				log(
					`SIGNALS ${ev.work} held — leg failed: ${e instanceof Error ? e.message : String(e)}`,
				);
				out.held++;
				break;
			}
			const verdict = parseVerdict(text);
			if (verdict === null) {
				state.attempts[key] = (state.attempts[key] ?? 0) + 1;
				log(`SIGNALS ${ev.work} held — unparseable verdict`);
				out.held++;
				break;
			}
			emitLoopEvent(
				"lane.signal",
				ev.work,
				{
					project: ev.project,
					work: ev.work,
					sid,
					class: verdict.cls,
					confidence: verdict.confidence,
					evidence: verdict.evidence,
					ts: now(),
				},
				store,
			);
			if (verdict.cls !== "clean") {
				appendBlamQueue({
					id: `signal-${ev.work}-${ev.id}`,
					ts: now(),
					project: ev.project,
					work: ev.work,
					sid,
					class: verdict.cls,
					confidence: verdict.confidence,
					evidence: verdict.evidence,
				});
				out.blamQueued++;
			}
			state.done[key] = now();
			delete state.attempts[key];
			state.lastId = ev.id;
			out.scanned.push({
				item: ev.work,
				cls: verdict.cls,
				confidence: verdict.confidence,
			});
			log(`SIGNALS ${ev.work} ${verdict.cls} (${verdict.confidence})`);
		}
		// drop attempt counters for items that resolved this fire
		for (const k of Object.keys(state.attempts))
			if (state.done[k] !== undefined) delete state.attempts[k];
		writeScanState(statePath, state);
		return out;
	};
}
