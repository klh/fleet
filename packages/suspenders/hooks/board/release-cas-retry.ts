// hooks/board/release-cas-retry.ts — W873: the release leg's claim-changed
// recovery, extracted from routes-actions so the near-cap route module stays
// patch-only. The CLI accepted its argv but the CAS release refused: re-read
// the claim once. A moved claim retries against the fresh owner/revision
// (both legs CAS-guarded — a retry can never release the wrong claimant);
// an unchanged claim means the reclaim gate refused — pass its reason
// through.
import { db, WORK_CLI } from "./context.ts";
import { runCli } from "./exec.ts";
import { json } from "./helpers.ts";

export function releaseCasRetry(
	project: string,
	id: string,
	w: { state: string; owner_sid: string; updated_at: number },
	force: boolean,
	repo: string,
	first: { code: number; out: string },
): Response {
	const w2 = db
		.query(
			"SELECT state, owner_sid, updated_at FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, id) as {
		state: string;
		owner_sid: string | null;
		updated_at: number;
	} | null;
	if (!w2?.owner_sid || !["CLAIMED", "RUNNING", "ORPHANED"].includes(w2.state))
		return json(
			{
				ok: false,
				error: `${id} is ${w2?.state ?? "gone"} — nothing to release`,
			},
			409,
		);
	if (w2.owner_sid === w.owner_sid && w2.updated_at === w.updated_at)
		return json(
			{ ok: false, error: `release refused: ${first.out.slice(0, 200)}` },
			409,
		);
	// the claim moved between our reads — one retry on the fresh expectations
	const rel = runCli(
		[
			WORK_CLI,
			"reclaim",
			id,
			...(force ? ["--force"] : []),
			"--expect-owner",
			w2.owner_sid,
			"--expect-updated-at",
			String(w2.updated_at),
			"--json",
		],
		repo,
	);
	if (rel.code !== 0)
		return json(
			{
				ok: false,
				error: `claim changed twice — release refused: ${rel.out.slice(0, 200)}`,
			},
			409,
		);
	// honest: after a moved claim we no longer know the old lane's liveness —
	// report dispatched:false so /api/reassign fires the ▶ after it retires
	return json({
		ok: true,
		item: id,
		released: w2.owner_sid,
		forced: false,
		dispatched: false,
	});
}
