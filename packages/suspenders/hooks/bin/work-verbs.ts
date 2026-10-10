// work-verbs.ts — W613: the claim-liveness verb bodies, extracted from
// work.ts (1500-line law). Reclaim + extend are the operator surface of
// lib/claim-liveness.ts; work.ts passes its CLI context in.
import type { GovernorStore } from "../lib/govdb.ts";
import {
	extendClaim,
	parseForMs,
	sweepReclaims,
} from "../lib/claim-liveness.ts";

type Item = Record<string, string | number | null>;

export type VerbCtx = {
	store: GovernorStore;
	project: string;
	pos: string[];
	rest: string[];
	flag: (name: string) => string | null;
	resolveSid: (as: string) => string;
	getItem: (id: string) => Item;
	releaseObserved: (
		it: Item,
		by: string,
		reason: "owner-release" | "operator-reclaim" | "reclaim-all",
	) => boolean;
	die: (msg: string) => never;
	cyan: (s: string) => string;
	dim: (s: string) => string;
};

export function runExtendVerb(ctx: VerbCtx): void {
	// W613: pre-extend a claim across a known-long op; the sweep holds it.
	const id = ctx.pos[0];
	const ms = parseForMs(ctx.flag("--for") ?? undefined);
	if (!id || !ms)
		ctx.die(`usage: extend <id> --for 45m --as <sid> [--note "why"]`);
	const as = ctx.flag("--as");
	const r = extendClaim(ctx.store, {
		project: ctx.project,
		id,
		sid: as ? ctx.resolveSid(as) : null,
		forMs: ms,
		note: ctx.flag("--note") ?? null,
	});
	if (!r.ok) ctx.die(r.why);
	console.log(
		`${ctx.cyan("·")} ${id} claim extended until ${new Date(r.until).toISOString()}`,
	);
}

export function runReclaimVerb(ctx: VerbCtx): void {
	if (ctx.pos[0] === "all") {
		// W339: `work reclaim all` — the supported bulk operation. Capsule law
		// preserved: this CAN strand uncommitted lane state; each reclaim is
		// listed for audit and `work reclaim <id>` stays the careful path.
		if (
			ctx.flag("--expect-owner") ||
			ctx.flag("--expect-updated-at") ||
			ctx.rest.includes("--json")
		)
			ctx.die("expected claim/JSON requires a single item");
		// W613: executor-scoped sweep (lib/claim-liveness.ts): local evidence
		// only for this executor's grants; foreign expire by store-hb age;
		// dead ×3 consecutive; unknown never releases.
		const verdicts = sweepReclaims(ctx.store, ctx.project);
		let n = 0;
		for (const v of verdicts) {
			if (v.action === "released") {
				console.log(
					`${ctx.cyan("·")} ${v.id} reclaimed → READY (was ${String(v.owner).slice(0, 8)}, ${v.why})`,
				);
				n++;
			} else if (v.verdict !== "live") {
				console.log(`${ctx.dim(String(v.id))} held — ${v.why}`);
			}
		}
		console.log(
			n === 0
				? ctx.dim("(no orphans to reclaim)")
				: `${ctx.cyan("·")} ${n} orphaned item(s) reclaimed`,
		);
	} else {
		const id = ctx.pos[0];
		const it = ctx.getItem(id ?? "");
		if (!["CLAIMED", "RUNNING", "ORPHANED"].includes(it.state as string))
			ctx.die(
				`${id} is ${it.state} — only CLAIMED/RUNNING/ORPHANED can be reclaimed`,
			);
		const expectedOwner = ctx.flag("--expect-owner");
		if (expectedOwner && it.owner_sid !== ctx.resolveSid(expectedOwner))
			ctx.die(`${id} owner changed — reclaim refused`);
		const revision = ctx.flag("--expect-updated-at");
		if (
			revision &&
			(!Number.isSafeInteger(Number(revision)) ||
				Number(revision) !== it.updated_at)
		)
			ctx.die(`${id} revision changed — reclaim refused`);
		if (!ctx.releaseObserved(it, "operator-reclaim", "operator-reclaim"))
			ctx.die(`${id} claim changed — reclaim refused; inspect before retrying`);
		console.log(
			ctx.rest.includes("--json")
				? JSON.stringify({
						project: ctx.project,
						id,
						previousOwner: it.owner_sid,
						previousUpdatedAt: it.updated_at,
						released: true,
					})
				: `${ctx.cyan("·")} ${id} reclaimed → READY`,
		);
	}
}
