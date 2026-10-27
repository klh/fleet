// work-enqueue.ts — queue a work item through the installed work CLI, the
// graph's one mint path. Shared by the post-merge scanners (decomposition
// soft cap, dangling-path aggregate) that file follow-up work.
import { join } from "node:path";

/** `work add <title> --desc <description> --by <source>` run from `repo`
 * through the installed prefix; the minted item id, or null when the CLI
 * refused or printed no id. */
export function enqueueWorkItem(
	repo: string,
	source: string,
	title: string,
	description: string,
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
		],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().match(/\bW\d+(?:\.\d+)*\b/)?.[0] ?? null;
}
