// hooks/board-html/conn-verdict.ts — the connection banner's verdict as a
// pure function of the data + decisions feed states (live / stale / error,
// decisions freshness, provenance title). <klh-conn-banner> renders it; the
// mediator computes it from the feed store. Formatters are injected so the
// function stays self-contained (board-format ago, wallclock dualStamp).

export type Observation = {
	source?: string;
	target?: string;
	scope?: string;
	observedAt?: number;
	expiresAt?: number;
};
export type ConnInput = {
	observation: Observation | null | undefined;
	dataOkAt: number;
	dataErr: string | null;
	decOkAt: number;
	decErr: string | null;
	decLoaded: boolean;
	now: number;
};
export type ConnVerdict = {
	cls: "live" | "stale" | "err";
	txt: string;
	dec: string;
	title: string;
	retry: boolean;
};

export function connVerdict(
	i: ConnInput,
	ago: (s: number) => string,
	stamp: (ms: number | undefined) => string,
): ConnVerdict {
	const o = i.observation;
	const secs = (ms: number) => Math.max(0, Math.round((i.now - ms) / 1000));
	const dAge =
		o && typeof o.observedAt === "number"
			? secs(o.observedAt)
			: i.dataOkAt
				? secs(i.dataOkAt)
				: -1;
	const expires = o ? Number(o.expiresAt) : Number.NaN;
	const evidenceStale =
		!!o &&
		(!Number.isFinite(expires) ||
			expires <= i.now ||
			Number(o.observedAt) > i.now + 5000);
	let cls: ConnClass = "live";
	let txt = "live";
	if (i.dataErr && !i.dataOkAt) {
		cls = "err";
		txt = "connecting";
	} else if (i.dataErr) {
		cls = "err";
		txt = `error — last good ${ago(dAge)}`;
	} else if (evidenceStale || dAge >= 5) {
		cls = "stale";
		txt = `stale snapshot — observed ${ago(dAge)}`;
	}
	const dec = !i.decLoaded
		? "decisions loading"
		: i.decErr
			? "decisions unavailable"
			: `decisions checked ${ago(i.decOkAt ? secs(i.decOkAt) : -1)}`;
	const title = o
		? `Source: ${o.source} · target: ${o.target} · scope: ${o.scope} · observed: ${stamp(o.observedAt)} · expires: ${stamp(o.expiresAt)}`
		: "Legacy feed without observation provenance";
	return { cls, txt, dec, title, retry: !!i.dataErr };
}
