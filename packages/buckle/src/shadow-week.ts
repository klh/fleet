// src/shadow-week.ts — the W144 shadow-week monitor's importable logic:
// bench-row parsing, the scenario-keyed day diff, and the bounded 7-day
// log window. The operator face (argv/env, the bench spawn, exit codes)
// is bin/shadow-week.ts; test/shadow-week.test.ts covers this module.

export const DAY_MS = 86_400_000;
const KEEP_MS = 7 * DAY_MS;

// ── bench row shape (subset the monitor reads) ──
export interface BenchRow {
	ts?: string;
	scenario: string;
	gate?: boolean;
	pass?: boolean | null;
	p50_ms?: number | null;
	p95_ms?: number | null;
	byte_identity_pct?: number | null;
	available?: boolean;
	notes?: string;
}

export const dayKey = (d: Date): string => {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
};

/** One JSON object per line; tolerate a torn final line (crash mid-write). */
export const parseBenchRows = (text: string): BenchRow[] => {
	const rows: BenchRow[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			rows.push(JSON.parse(line) as BenchRow);
		} catch {
			// torn line — the rest of the file still parses
		}
	}
	return rows;
};

export interface Flagged {
	scenario: string;
	flags: string[];
	hard: boolean;
}

const GATE_BUDGET = { p50: 5, p95: 15 };

/** Scenario-keyed diff of today vs the prior day. First day (no prior) is
 *  recorded, never flagged. */
export function diffDay(today: BenchRow[], prior: BenchRow[]): Flagged[] {
	const priorBy = new Map(prior.map((r) => [r.scenario, r]));
	const out: Flagged[] = [];
	for (const r of today) {
		const flags: string[] = [];
		let hard = false;
		if (r.gate === true && r.pass === false) {
			flags.push("gate-fail");
			hard = true;
		}
		if (
			r.gate === true &&
			((r.p50_ms !== null &&
				r.p50_ms !== undefined &&
				r.p50_ms >= GATE_BUDGET.p50) ||
				(r.p95_ms !== null &&
					r.p95_ms !== undefined &&
					r.p95_ms >= GATE_BUDGET.p95))
		) {
			flags.push("gate-budget");
			hard = true;
		}
		if (
			r.byte_identity_pct !== null &&
			r.byte_identity_pct !== undefined &&
			r.byte_identity_pct < 100 &&
			r.scenario !== "failover-mid-stream"
		) {
			flags.push("byte-identity");
			hard = true;
		}
		const p = priorBy.get(r.scenario);
		if (p) {
			if (
				typeof r.p50_ms === "number" &&
				typeof p.p50_ms === "number" &&
				p.p50_ms > 0 &&
				r.p50_ms > 2 * p.p50_ms
			)
				flags.push(`tolerance:p50>2x-prior(${String(p.p50_ms)}ms)`);
			if (
				typeof r.p95_ms === "number" &&
				typeof p.p95_ms === "number" &&
				p.p95_ms > 0 &&
				r.p95_ms > 2 * p.p95_ms
			)
				flags.push(`tolerance:p95>2x-prior(${String(p.p95_ms)}ms)`);
			if (p.available === true && r.available === false)
				flags.push("litellm-unavailable-was-up");
			if (p.available === false && r.available === true)
				flags.push("litellm-recovered");
		}
		out.push({ scenario: r.scenario, flags, hard });
	}
	const todayBy = new Map(today.map((r) => [r.scenario, r]));
	for (const p of prior) {
		if (!todayBy.has(p.scenario)) {
			out.push({
				scenario: p.scenario,
				flags: ["missing-scenario"],
				hard: false,
			});
		}
	}
	return out;
}

/** Bounded log: keep only rows within the window (7 days). */
export function boundKeep(lines: string[], nowMs: number): string[] {
	return lines.filter((l) => {
		try {
			const r = JSON.parse(l) as { ts?: string };
			if (!r.ts) return false;
			const t = Date.parse(r.ts);
			return Number.isFinite(t) && nowMs - t <= KEEP_MS;
		} catch {
			return false; // torn/foreign line — drop
		}
	});
}

