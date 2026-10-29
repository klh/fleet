// hooks/board-html/board-format.ts — the ONE age vocabulary for the board.
// Lit components import these; the legacy chunk scope embeds them via
// toString() (core.ts), so both render paths say "12s ago" the same way.
// Self-contained on purpose: no imports, no closures over module state.

/** Seconds → "just now" / "12s ago" / "3 minutes ago" … ("" when unknown). */
export function ago(s: number | null | undefined): string {
	if (s == null || s < 0) return "";
	if (s < 10) return "just now";
	if (s < 60) return `${s}s ago`;
	if (s < 3600) {
		const m = Math.round(s / 60);
		return `${m}${m === 1 ? " minute" : " minutes"} ago`;
	}
	if (s < 86400) {
		const h = Math.round(s / 3600);
		return `${h}${h === 1 ? " hour" : " hours"} ago`;
	}
	const dd = Math.round(s / 86400);
	return `${dd}${dd === 1 ? " day" : " days"} ago`;
}

/** Seconds → compact "12s" / "3m" / "2h" / "4d" ("-" when unknown). */
export function agoShort(s: number | null | undefined): string {
	if (s == null || s < 0) return "-";
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

/** Epoch ms → whole seconds elapsed (null when unknown). */
export function msAgo(ts: number | null | undefined): number | null {
	return ts != null ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null;
}
