// decision-dups.ts — W798 duplicate decision-card collapse. Deterministic
// same-anchor grouping; contract: docs/decisions-api.md "W798 duplicate
// collapse + class rulings".

export function decisionAnchor(question: string): string | null {
	let best: string | null = null;
	for (const t of question.split(/[^A-Za-z0-9_./:-]+/)) {
		const norm = t.replace(/:\d+.*$/, "").toLowerCase();
		if (!norm) continue;
		const slashes = (norm.match(/\//g) ?? []).length;
		const dots = (norm.match(/\./g) ?? []).length;
		if (slashes < 2 && dots < 2) continue;
		if (best === null || norm.length > best.length) best = norm;
	}
	return best;
}

export function collapseDups(
	recs: Record<string, unknown>[],
): Record<string, unknown>[] {
	const groups = new Map<string, Record<string, unknown>[]>();
	for (const r of recs) {
		if (r.state !== "OPEN") continue;
		const anchor = decisionAnchor(String(r.question ?? ""));
		if (!anchor) continue;
		const key = `${String(r.project ?? "")} ${anchor}`;
		const g = groups.get(key) ?? [];
		g.push(r);
		groups.set(key, g);
	}
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		const primary = g.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
		primary.dup_count = g.length;
		for (const m of g) if (m !== primary) m.dup_of = primary.id;
	}
	return recs;
}
