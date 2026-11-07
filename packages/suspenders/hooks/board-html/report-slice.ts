// hooks/board-html/report-slice.ts — the report family's slice + row types
// (shared by the leaf and the mediator so each imports the shape, never the
// other — no vendored entry imports another entry; the vendor-hash
// shared-chunk guard). Loose on purpose: the /api/report payload feeds
// render stamps and chips; the wire itself stays gated by the feed accept
// in the mediator.

/** One expandable row of /api/report (the report-face payload row). */
export type ReportRowState = {
	id: string;
	st: string;
	title: string;
	lastEventTs: number | null;
};

/** One /api/report payload (loose subset — the feed accept gates the wire). */
export type ReportFeed = {
	ts?: number;
	project?: string;
	table?: string;
	rows?: ReportRowState[];
	capacity?: string;
};

/** The slice the mediator computes and pushes down as a property. */
export type ReportSlice = {
	loaded: boolean;
	err: string | null;
	okAt: number;
	/** last good /api/report payload (kept visible on later failures) */
	data: ReportFeed | null;
	/** the expanded row id ('' = none) */
	open: string;
	/** the expanded row's last good /api/report-row payload */
	detail: ReportRowDetail | null;
	detailErr: string | null;
	/** true while the row detail's first fetch is in flight */
	detailBusy: boolean;
};

/** One /api/report-row payload (loose subset). */
export type ReportRowDetail = {
	id?: string;
	state?: string;
	ownerSid?: string | null;
	lastEventTs?: number | null;
	laneTail?: { text: string; ts: string | null }[];
};
