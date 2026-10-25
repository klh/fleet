// hooks/lib/gates/outage-ledger.ts — auditable degraded outcomes at enforcement
// boundaries (W576.3). Owner law: gates are guard-rails, not boundaries —
// a dead registry must never block an edit — but fail-open is a decision,
// not silence: a boundary that continues without its authority records one
// structured outage event to a file ledger OUTSIDE the dead authority (the
// store may be exactly what's broken). Best-effort by contract: if even the
// ledger write fails (REG itself unwritable), the boundary still fails open,
// and recordOutage reports false instead of throwing.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OutageEvent {
	/** boundary id — "governor.edit" is the file-edit gate */
	op: string;
	/** where in the boundary the authority went missing */
	phase: string;
	/** bounded classification of the underlying failure */
	reasonCode: string;
	/** the resource the pending decision was heading toward (when known) */
	path?: string;
}

/** SUSPENDERS_OUTAGE_LEDGER override (isolated-HOME tests cover the default
 *  path; the env seam keeps subprocess tests on a private ledger). Resolved
 *  per call so a test's env change is honored on the next event. */
function ledgerPath(): string {
	return (
		process.env.SUSPENDERS_OUTAGE_LEDGER ??
		`${process.env.HOME}/.cache/claude-governor/outage.jsonl`
	);
}

/** Dedupe window: one event per (op, phase, reasonCode) per window keeps the
 *  ledger bounded during a sustained outage without hiding recurrence. */
export const OUTAGE_DEDUPE_MS = 30_000;

/** Classify an unknown throw into a bounded reasonCode — raw messages carry
 *  path noise; the class is what audit readers count. */
export function classifyOutage(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/SQLITE|database|WAL|journal/i.test(msg)) return "store-unavailable";
	if (/ENOENT|ENOTDIR|EACCES|EEXIST|EISDIR|permission/i.test(msg))
		return "fs-denied";
	if (/migration|user_version|schema/i.test(msg)) return "schema";
	return "unknown";
}

/** Latest recorded event, or null when the ledger is absent/empty/garbage.
 *  Read model for tests and any future board probe — the file is append-only. */
export function lastOutage(): (OutageEvent & { at: number }) | null {
	try {
		const text = readFileSync(ledgerPath(), "utf8").trim();
		if (!text) return null;
		const line = text.slice(text.lastIndexOf("\n") + 1);
		const j = JSON.parse(line) as OutageEvent & { at: number };
		return typeof j?.at === "number" && typeof j?.op === "string" ? j : null;
	} catch {
		return null;
	}
}

export function recordOutage(ev: OutageEvent, now = Date.now()): boolean {
	try {
		const p = ledgerPath();
		const prev = lastOutage();
		if (
			prev &&
			prev.op === ev.op &&
			prev.phase === ev.phase &&
			prev.reasonCode === ev.reasonCode &&
			now - prev.at < OUTAGE_DEDUPE_MS
		)
			return false;
		mkdirSync(dirname(p), { recursive: true });
		appendFileSync(
			p,
			`${JSON.stringify({ at: now, op: ev.op, phase: ev.phase, reasonCode: ev.reasonCode, path: ev.path })}\n`,
		);
		return true;
	} catch {
		// even the audit failed — fail-open stands, nothing more to do
		return false;
	}
}
