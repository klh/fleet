// hooks/board-html/setup-slice.ts — the setup family's slice types (shared
// by the leaf and the mediator so each imports the shape, never the other —
// no vendored entry imports another entry; the vendor-hash shared-chunk
// guard). Loose on purpose: the /api/setup payload feeds the grouped
// checklist; the wire itself stays gated by the feed accept in the
// mediator.

/** One setup check row of /api/setup (the checklist payload row). */
export type SetupCheck = {
	id?: string;
	label?: string;
	ok?: boolean;
	detail?: string | null;
	fix?: string | null;
};

/** One /api/setup payload (loose subset — the feed accept gates the wire). */
export type SetupFeed = {
	ok?: boolean;
	ts?: number;
	checks?: SetupCheck[];
};

/** The slice the mediator computes and pushes down as a property. */
export type SetupSlice = {
	/** true once a payload (seed or fetch) has landed */
	loaded: boolean;
	err: string | null;
	okAt: number;
	/** last good /api/setup payload (kept visible on later failures) */
	data: SetupFeed | null;
};
