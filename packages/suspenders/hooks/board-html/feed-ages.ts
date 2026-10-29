// hooks/board-html/feed-ages.ts — relative ages derived on the CLIENT from
// the absolute stamps every polled feed carries (sessions.hb, claims/events/
// facts .ts, project rows .updatedAt, tasks .updated_at_utc, decisions
// .created_ts). The server's weak ETag ignores the relative-age fields
// (board/etag.ts), so an unchanged feed answers 304 — and a 304 keeps the
// last body, whose server-computed ages would freeze. stampAges recomputes
// them in place from the stamps; the feeds call it on a 304 (a 200 already
// carries fresh server ages) with `now` on the SERVER clock (viewer clock
// minus the skew measured on the last 200), then re-render.
// Self-contained on purpose (embedded via toString() in core.ts): no
// imports, no closures over module state.

/** Recompute every *Ago / age_s field of a board feed payload in place. */
export function stampAges(j: unknown, now: number): unknown {
	const secs = (t: unknown): number => {
		const ms = typeof t === "string" ? Date.parse(t) : Number(t);
		return t != null && Number.isFinite(ms) && ms > 0
			? Math.max(0, Math.round((now - ms) / 1000))
			: -1;
	};
	const rows = (xs: unknown, stamp: string, field: string): void => {
		if (!Array.isArray(xs)) return;
		for (const x of xs)
			if (x && typeof x === "object" && stamp in x)
				(x as Record<string, unknown>)[field] = secs(
					(x as Record<string, unknown>)[stamp],
				);
	};
	if (!j || typeof j !== "object") return j;
	const o = j as Record<string, unknown>;
	// A 304 is the server re-observing the same state: slide the provenance
	// window forward with it, or the conn banner reads "stale snapshot".
	const ob = o.observation as Record<string, unknown> | null | undefined;
	if (ob && typeof ob.observedAt === "number") {
		const shift = now - ob.observedAt;
		ob.observedAt = now;
		if (typeof ob.expiresAt === "number") ob.expiresAt += shift;
	}
	rows(o.sessions, "hb", "hbAgo");
	rows(o.claims, "ts", "tsAgo");
	rows(o.events, "ts", "tsAgo");
	rows(o.facts, "ts", "tsAgo");
	rows(o.inbox, "ts", "tsAgo");
	rows(o.tasks, "updated_at_utc", "age_s");
	rows(o.decisions, "created_ts", "age_s");
	if (Array.isArray(o.projects))
		for (const p of o.projects)
			if (p && typeof p === "object")
				for (const v of Object.values(p as Record<string, unknown>))
					rows(v, "updatedAt", "updatedAgo");
	return j;
}
