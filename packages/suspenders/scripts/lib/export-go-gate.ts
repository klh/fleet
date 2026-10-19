// export-go-gate.ts — W552.8: the W552 export preflight reads the owner GO
// instead of assuming the gate is closed (the lane closed every attempt with
// "Nothing new - parent operator-gated" without ever reading the bus). GO
// evidence, either passes:
//   1. a coord bus BROADCAST whose note carries OWNER GO + W552 (the live GO
//      is event #46573, verbatim "GO"), or
//   2. a 0600 .fleet/demos/ikea-recording/go-owner seal written at GO time —
//      materialized by the preflight from the bus when absent, so the
//      evidence survives bus retention.
// The pure decision core lives here; w552-8-export-preflight.ts owns the
// CLI side (bus read via the coord CLI, seal write, exporter invocation).
export interface GoEvent {
	id: number;
	ts: number;
	note: string;
}

export interface GoSeal {
	event: number;
	ts: number;
	note: string;
}

/** The marker every owner-GO surface carries: verbatim GO + the item id. */
export const isOwnerGoNote = (note: string): boolean =>
	note.includes("OWNER GO") && note.includes("W552");

/** Scan coord `events --json` output for the W552 owner-GO broadcast —
 *  the newest match wins (the scan is newest-first). */
export const goEventFromScan = (scan: unknown): GoEvent | null => {
	const events = (scan as { events?: unknown })?.events;
	if (!Array.isArray(events)) return null;
	for (const row of events) {
		const e = row as {
			id?: unknown;
			ts?: unknown;
			kind?: unknown;
			payload?: { note?: unknown };
		};
		if (e.kind !== "BROADCAST") continue;
		const note = typeof e.payload?.note === "string" ? e.payload.note : "";
		if (!isOwnerGoNote(note)) continue;
		return { id: Number(e.id ?? 0) || 0, ts: Number(e.ts ?? 0) || 0, note };
	}
	return null;
};

/** Parse a go-owner seal file's JSON; null when unset or corrupt. */
export const parseGoSeal = (text: string): GoSeal | null => {
	try {
		const o = JSON.parse(text) as Partial<GoSeal>;
		if (typeof o.note !== "string" || !isOwnerGoNote(o.note)) return null;
		return {
			event: Number(o.event ?? 0) || 0,
			ts: Number(o.ts ?? 0) || 0,
			note: o.note,
		};
	} catch {
		return null;
	}
};

/** 0600 exactly — the seal is a 0600 evidence file; group/other bits deny. */
export const modeIs0600 = (mode: number): boolean => (mode & 0o777) === 0o600;

/** The seal body written at GO time, from the bus event. */
export const sealFromEvent = (e: GoEvent): GoSeal => ({
	event: e.id,
	ts: e.ts,
	note: e.note,
});
