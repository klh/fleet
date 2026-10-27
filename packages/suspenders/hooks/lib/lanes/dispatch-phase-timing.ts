// dispatch-phase-timing.ts — W1176: phase timing for pre-brief dispatch
// preparation. Passive wall-clock spans recorded from the EXISTING telemetry
// primitives (the loop log + the governor events bus, source "dispatch") —
// no gate weakened, no timeout raised, no cache bypassed: the collector only
// measures, admission/health stay fail-closed verbatim.
import { appendFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";
import { openStore } from "../govdb/govdb.ts";

export interface PhaseSpan {
	/** tool | probe.buckle-front | admission.audit | brief.compose */
	phase: string;
	/** argv-derived identity for tool spans (e.g. "work take"), else = phase */
	name: string;
	ms: number;
	ok: boolean;
}

/** Bounded: a refill cycle dispatching many items must not grow this
 *  unbounded; beyond the cap only a dropped count survives (saturate, never
 *  throw). */
const MAX_SPANS = 600;
const spans: PhaseSpan[] = [];
let dropped = 0;
/** Process birth (epoch ms) — the dispatch prep wall clock. `dispatch`
 *  runs are short-lived processes, so timeOrigin ≈ the dispatch launch. */
const startedAt = performance.timeOrigin;

const push = (s: PhaseSpan): void => {
	if (spans.length >= MAX_SPANS) dropped++;
	else spans.push(s);
};

/** Passive span recorder for in-process phases (route-admission audit read,
 *  brief compose, buckle-front probe). Never throws. */
export const recordPhase = (phase: string, ms: number, ok = true): void => {
	push({ phase, name: phase, ms, ok });
};

/** argv-derived tool identity: [bun, /…/bin/work.ts, take, W…] → "work take";
 *  [git, -C, <path>, branch, …] → "git branch" (paths and flags skipped). */
export const dispatchToolName = (cmd: string[]): string => {
	const si = cmd.findIndex((a, i) => i > 0 && a.endsWith(".ts"));
	const rest = si >= 0 ? cmd.slice(si + 1) : cmd.slice(1);
	const verb = rest.find((a) => !a.startsWith("-") && !a.includes("/"));
	const base =
		si >= 0 ? basename(cmd[si]).replace(/\.ts$/, "") : basename(cmd[0] ?? "");
	return verb ? `${base} ${verb}` : base;
};

/** Cycle/test support: drop accumulated spans + the dropped count. A
 *  long-lived supervise process resets at each cycle boundary so spans never
 *  bridge unrelated dispatch cycles. */
export const resetDispatchPhases = (): void => {
	spans.length = 0;
	dropped = 0;
};

/** Timed spawn wrapper — wraps the shared lane.ts run/sh so every dispatch
 *  subprocess (work take/show/ready, coord bootstrap/capsule, worktree
 *  create/retire, git reads) is phase-attributed without touching call
 *  sites. Timing only: failures propagate verbatim after the span lands. */
export const timedDispatchSpawn = <T>(
	impl: (cmd: string[], cwd?: string) => T,
	cmd: string[],
	cwd?: string,
): T => {
	const t = performance.now();
	let ok = true;
	try {
		return impl(cmd, cwd);
	} catch (e) {
		ok = false;
		throw e;
	} finally {
		push({
			phase: "tool",
			name: dispatchToolName(cmd),
			ms: performance.now() - t,
			ok,
		});
	}
};

export interface DispatchPhaseAggregate {
	count: number;
	ms: number;
	maxMs: number;
	failed: number;
}

/** Aggregate spans by identity — N+1 surfaces as count, a blocker as
 *  ms/maxMs. */
export const aggregatePhases = (
	rows: PhaseSpan[],
): Map<string, DispatchPhaseAggregate> => {
	const out = new Map<string, DispatchPhaseAggregate>();
	for (const s of rows) {
		const a = out.get(s.name) ?? { count: 0, ms: 0, maxMs: 0, failed: 0 };
		a.count++;
		a.ms += s.ms;
		a.maxMs = Math.max(a.maxMs, s.ms);
		if (!s.ok) a.failed++;
		out.set(s.name, a);
	}
	return out;
};

/** Flush one run's phase timing: one PHASE-TIMING line on console + loop.log
 *  and one `dispatch.phase` events row (source "dispatch", scope = item).
 *  Dry runs print only — read-only end to end. Fail-soft: telemetry never
 *  kills a dispatch. */
export const endDispatchPhases = (
	ctx: { fleet: string; item?: string; sid?: string; dry?: boolean },
	store?: GovernorStore,
): void => {
	if (!spans.length) return;
	const totalMs = Math.max(0, Date.now() - startedAt);
	const agg = aggregatePhases(spans);
	const top = [...agg.entries()]
		.sort((a, b) => b[1].ms - a[1].ms)
		.slice(0, 8)
		.map(([name, a]) => `${name}×${a.count}=${Math.round(a.ms)}ms`)
		.join(" ");
	const line =
		`PHASE-TIMING total=${Math.round(totalMs)}ms spans=${spans.length + dropped} ${top}`.trimEnd();
	console.log(line);
	if (ctx.dry) return;
	try {
		mkdirSync(ctx.fleet, { recursive: true });
		appendFileSync(
			`${ctx.fleet}/loop.log`,
			`${new Date().toISOString()} ${line}${ctx.item ? ` item=${ctx.item}` : ""}\n`,
		);
	} catch {}
	const s = store ?? openStore();
	try {
		s.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'dispatch', 'dispatch.phase', ?, ?, NULL)",
		).run(
			Date.now(),
			ctx.item ?? ctx.sid ?? "dispatch",
			JSON.stringify({
				...(ctx.item ? { item: ctx.item } : {}),
				...(ctx.sid ? { sid: ctx.sid } : {}),
				totalMs,
				...(dropped ? { dropped } : {}),
				spans: spans.map((sp) => ({ ...sp, ms: Math.round(sp.ms) })),
			}),
		);
	} catch {}
};
