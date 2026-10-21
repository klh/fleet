/** Bounded, body-free executor intent. This is diagnostic metadata, not
 * authorization or an instruction to any router. */
export interface PreferHeaderDecision {
	source: "dotfile" | "default" | "posture";
	directive: "must" | "prefer" | "can" | "default" | "posture";
	line: number;
	index: number;
	target: string;
	can: "absent" | "active" | "unavailable";
}

export const PREFER_HEADER = "x-klh-prefer";
const TARGET = /^[A-Za-z0-9._:/-]{1,96}$/;
const HEADER =
	/^v=1;source=(dotfile|default|posture);directive=(must|prefer|can|default|posture);line=(\d{1,5});index=(\d{1,5});target=([A-Za-z0-9._:/-]{1,96});can=(absent|active|unavailable)$/;

/** Reject unexpected values rather than putting file content in HTTP. */
export function encodePreferHeader(d: PreferHeaderDecision): string | null {
	if (!TARGET.test(d.target)) return null;
	if (
		![d.line, d.index].every(
			(n) => Number.isSafeInteger(n) && n >= 0 && n <= 99999,
		)
	)
		return null;
	const value = `v=1;source=${d.source};directive=${d.directive};line=${d.line};index=${d.index};target=${d.target};can=${d.can}`;
	return HEADER.test(value) ? value : null;
}

/** Canonicalize untrusted inbound metadata before echoing or relaying it. */
export function parsePreferHeader(value: string | null): string | null {
	if (!value || value.length > 192) return null;
	const match = HEADER.exec(value);
	if (!match) return null;
	return encodePreferHeader({
		source: match[1] as PreferHeaderDecision["source"],
		directive: match[2] as PreferHeaderDecision["directive"],
		line: Number(match[3]),
		index: Number(match[4]),
		target: match[5],
		can: match[6] as PreferHeaderDecision["can"],
	});
}
