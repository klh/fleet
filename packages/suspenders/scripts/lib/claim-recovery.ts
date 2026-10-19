import { hostname } from "node:os";
import { captureClaimFeed } from "./structured-feed.ts";
import { isOwnerGated } from "./ready-pool.ts";

export type RecoverableClaim = {
	id: string;
	owner_sid: string;
	state: "CLAIMED" | "RUNNING";
	title: string;
	updated_at: number;
};

/** Registered lanes keep their original retry history; manual owners stay put. */
export function recoverableClaims(
	rows: unknown,
	registered: Set<string>,
	now: number,
	ownerGated: (title: string) => boolean,
	thisHost: string,
): RecoverableClaim[] {
	if (!Array.isArray(rows)) return [];
	return rows.filter(
		(r): r is RecoverableClaim =>
			r !== null &&
			typeof r === "object" &&
			typeof r.id === "string" &&
			/^W\d+(?:\.\d+)*$/.test(r.id) &&
			typeof r.owner_sid === "string" &&
			/^autow[\w.-]+$/.test(r.owner_sid) &&
			!registered.has(r.owner_sid) &&
			(r.state === "CLAIMED" || r.state === "RUNNING") &&
			typeof r.title === "string" &&
			!ownerGated(r.title) &&
			typeof r.origin === "string" &&
			r.origin.startsWith(`${thisHost}:`) &&
			typeof r.updated_at === "number" &&
			Number.isFinite(r.updated_at) &&
			now - r.updated_at >= 15 * 60_000,
	);
}

/** W928: the dispatch loop's orphaned-claim capture, moved from dispatch-next main(). */
export const recoverOrphanClaims = async (o: {
	workCli: (...args: string[]) => string;
	repo: string;
	log: (msg: string) => void;
	dry: boolean;
	item?: string;
	takenSids: Set<string>;
	targetEff: number;
	busySlots: number;
	now: number;
}): Promise<{ refused: string | null; rows: RecoverableClaim[] }> => {
	let orphaned: Record<string, unknown>[];
	try {
		orphaned = await captureClaimFeed(
			o.workCli("orphaned", "--json", ...(o.item ? ["--item", o.item] : [])),
			o.repo,
		);
	} catch (error) {
		const note = `RECOVERY REFUSED — ${String(error)}; no lanes dispatched`;
		console.error(note);
		if (!o.dry) o.log(note);
		return { refused: note, rows: [] };
	}
	const candidates = recoverableClaims(
		orphaned,
		o.takenSids,
		o.now,
		isOwnerGated,
		hostname(),
	);
	const slots = Math.max(0, o.targetEff - o.busySlots);
	return {
		refused: null,
		rows: candidates.filter((r) => !o.item || r.id === o.item).slice(0, slots),
	};
};
