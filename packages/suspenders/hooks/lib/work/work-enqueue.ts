// work-enqueue.ts — queue a work item through the installed work CLI, the
// graph's one mint path. Shared by the post-merge scanners (decomposition
// soft cap, dangling-path aggregate) that file follow-up work.
import { join } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";

/** W1476: the id of an item carrying exactly this title, or undefined. Open
 *  items only (not DONE/SUPERSEDED) unless `anyState` — a case minted once
 *  per incident stays minted after it closes. */
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

/** `work add <title> --desc <description> --by <source> [--tag t1,t2]` run
 * from `repo` through the installed prefix; the minted item id, or null when
 * the CLI refused or printed no id. */
export function enqueueWorkItem(
	repo: string,
	source: string,
	title: string,
	description: string,
	tags: readonly string[] = [],
): string | null {
	const bin =
		process.env.SUSPENDERS_PREFIX ??
		join(process.env.HOME ?? "", ".claude/hooks/suspenders");
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(bin, "bin/work.ts"),
			"add",
			title,
			"--desc",
			description,
			"--by",
			source,
			...(tags.length ? ["--tag", tags.join(",")] : []),
		],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().match(/\bW\d+(?:\.\d+)*\b/)?.[0] ?? null;
}
