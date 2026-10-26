// work-enqueue.ts — W1476: the ONE post-merge mint channel. Merge-ladder
// scanners (dangling paths W1302.2, the decomposition soft cap, review evals
// W1476) turn findings into graph items through the installed `work add`
// verb, run in the repo, so project identity, id allocation and the
// work.added event stay owned by the work CLI. Callers keep their own
// failure text: enqueueWorkItem returns undefined, it never throws.
import { join } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";

/** The id of an item carrying exactly this title, or undefined. Open items
 *  only (not DONE/SUPERSEDED) unless `anyState` — a case minted once per
 *  incident stays minted after it closes. */
export function itemByTitle(
	db: GovernorStore,
	project: string,
	title: string,
	anyState = false,
): string | undefined {
	const row = db
		.query(
			anyState
				? "SELECT id FROM work_items WHERE project = ? AND title = ? LIMIT 1"
				: "SELECT id FROM work_items WHERE project = ? AND title = ? AND state NOT IN ('DONE', 'SUPERSEDED') LIMIT 1",
		)
		.get(project, title) as { id: string } | null;
	return row?.id;
}

/** Mint one item via `work add`; the minted id, or undefined on failure. */
export function enqueueWorkItem(options: {
	repo: string;
	title: string;
	description: string;
	source: string;
	tags?: string[];
}): string | undefined {
	const bin =
		process.env.SUSPENDERS_PREFIX ??
		join(process.env.HOME ?? "", ".claude/hooks/suspenders");
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(bin, "bin/work.ts"),
			"add",
			options.title,
			"--desc",
			options.description,
			"--by",
			options.source,
			...(options.tags?.length ? ["--tag", options.tags.join(",")] : []),
		],
		{ cwd: options.repo, stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0
		? result.stdout.toString().match(/\bW\d+(?:\.\d+)*\b/)?.[0]
		: undefined;
}
