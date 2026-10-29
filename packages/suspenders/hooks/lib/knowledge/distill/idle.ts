// distill/idle.ts — "is the hub quiet?" The distiller runs only when every
// configured input agrees: live lanes <= idle_lanes_max, no interactive
// session activity for quiet_minutes, the load probe (buckle pressure, or
// the router's /metrics) at or under its max, and the local time inside the
// window. The verdict is re-read between EVERY unit of work: the moment
// activity resumes the run stops. An unreadable probe reads as busy — the
// distiller never competes with lanes for provider concurrency.
import { z } from "zod";
import type { DistillConfig } from "./config.ts";

export const IdleSignalsSchema = z
	.object({
		liveLanes: z.number().int().min(0),
		/** epoch ms of the newest interactive heartbeat; null = none */
		interactiveAt: z.number().nullable(),
		/** probe read (in-flight / pressure); null = unreadable or unconfigured */
		pressure: z.number().nullable(),
		now: z.number(),
	})
	.strict();
export type IdleSignals = z.infer<typeof IdleSignalsSchema>;

export interface IdleVerdict {
	idle: boolean;
	reason: string;
}

const minutesOf = (hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
};

/** Inside [start, end) local time; a window that wraps midnight works. */
export function insideWindow(
	w: { start: string; end: string },
	now: number,
): boolean {
	const d = new Date(now);
	const t = d.getHours() * 60 + d.getMinutes();
	const s = minutesOf(w.start);
	const e = minutesOf(w.end);
	return s <= e ? t >= s && t < e : t >= s || t < e;
}

export function idleVerdict(sig: IdleSignals, c: DistillConfig): IdleVerdict {
	if (sig.liveLanes > c.idle_lanes_max)
		return { idle: false, reason: `busy:lanes ${String(sig.liveLanes)}` };
	if (
		sig.interactiveAt !== null &&
		sig.now - sig.interactiveAt < c.quiet_minutes * 60_000
	)
		return { idle: false, reason: "busy:interactive" };
	if (c.pressure) {
		if (sig.pressure === null)
			return { idle: false, reason: "busy:pressure-unreadable" };
		if (sig.pressure > c.pressure.max)
			return { idle: false, reason: `busy:pressure ${String(sig.pressure)}` };
	}
	if (c.window && !insideWindow(c.window, sig.now))
		return { idle: false, reason: "busy:outside-window" };
	return { idle: true, reason: "idle" };
}

/** Read a number at a dot path of a JSON body, or sum a Prometheus series. */
export function readProbe(
	format: "json" | "prometheus",
	field: string,
	body: string,
): number | null {
	if (format === "prometheus") {
		let sum = 0;
		let seen = false;
		for (const line of body.split("\n")) {
			if (line.startsWith("#")) continue;
			const m = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([-\d.eE+]+)/.exec(line);
			if (m?.[1] === field) {
				const v = Number(m[2]);
				if (Number.isFinite(v)) {
					sum += v;
					seen = true;
				}
			}
		}
		return seen ? sum : null;
	}
	let cur: unknown;
	try {
		cur = JSON.parse(body);
	} catch {
		return null;
	}
	for (const part of field.split(".")) {
		if (!cur || typeof cur !== "object") return null;
		cur = (cur as Record<string, unknown>)[part];
	}
	return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

const LANE_FRESH_MS = 5 * 60_000;

/** The one read the signals need — a governor Database or GovernorStore. */
export interface SessionReader {
	query(sql: string): { get(...args: number[]): unknown };
}

/** Lane / interactive activity from the governor sessions table. A lane is
 *  a dispatched session (`auto*` / `review-*` sids); every other RUNNING
 *  session with a fresh heartbeat is interactive. */
export function sessionSignals(
	gov: SessionReader,
	now: number,
): { liveLanes: number; interactiveAt: number | null } {
	const lanes = gov
		.query(
			"SELECT COUNT(*) AS n FROM sessions WHERE state = 'RUNNING' AND hb > ? AND (sid LIKE 'auto%' OR sid LIKE 'review-%' OR role IN ('lane', 'reviewer'))",
		)
		.get(now - LANE_FRESH_MS) as { n: number };
	const inter = gov
		.query(
			"SELECT MAX(hb) AS at FROM sessions WHERE state = 'RUNNING' AND NOT (sid LIKE 'auto%' OR sid LIKE 'review-%' OR COALESCE(role, '') IN ('lane', 'reviewer'))",
		)
		.get() as { at: number | null };
	return { liveLanes: lanes.n, interactiveAt: inter.at };
}

/** Production signal source: sessions + the configured probe, cached for
 *  `cacheMs` so a per-unit re-check costs one cheap read at most. */
export function productionSignals(
	c: DistillConfig,
	gov: () => SessionReader,
	opts: { cacheMs?: number; fetch?: typeof fetch } = {},
): () => Promise<IdleSignals> {
	const cacheMs = opts.cacheMs ?? 1000;
	const doFetch = opts.fetch ?? fetch;
	let last: { at: number; sig: IdleSignals } | null = null;
	return async () => {
		const now = Date.now();
		if (last && now - last.at < cacheMs) return last.sig;
		const s = sessionSignals(gov(), now);
		let pressure: number | null = null;
		if (c.pressure) {
			try {
				const r = await doFetch(c.pressure.url, {
					signal: AbortSignal.timeout(c.pressure.timeout_ms),
				});
				pressure = r.ok
					? readProbe(c.pressure.format, c.pressure.field, await r.text())
					: null;
			} catch {
				pressure = null;
			}
		}
		const sig = { ...s, pressure, now };
		last = { at: now, sig };
		return sig;
	};
}
