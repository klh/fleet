import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openGovernorDb, projectIdentity } from "./govdb.ts";

export const CODE_LINE_SOFT_CAP = 1500;
const codePath =
	/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|vue|svelte)$/i;
const excluded = /(?:^|\/)(?:vendor|generated|dist|build|node_modules)\//;
export interface OversizedFile {
	path: string;
	lines: number;
	blob: string;
}
const git = (repo: string, args: string[]): Buffer => {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error("Unable to inspect merged code");
	return result.stdout;
};

/** Inspect committed blobs, not dirty working files or isolated lane versions. */
export function oversizedMergedFiles(
	repo: string,
	before: string,
	after: string,
	changedThrough = after,
): OversizedFile[] {
	const paths = git(repo, [
		"diff",
		"--name-only",
		"--diff-filter=ACMR",
		"-z",
		before,
		changedThrough,
	])
		.toString()
		.split("\0")
		.filter(Boolean);
	const findings: OversizedFile[] = [];
	for (const path of paths) {
		if (!codePath.test(path) || excluded.test(path)) continue;
		if (!git(repo, ["ls-tree", "-z", after, "--", path]).length) continue;
		const body = git(repo, ["show", `${after}:${path}`]);
		if (body.includes(0)) continue;
		let lines = body.length && body[body.length - 1] !== 10 ? 1 : 0;
		for (const byte of body) if (byte === 10) lines++;
		if (lines > CODE_LINE_SOFT_CAP)
			findings.push({
				path,
				lines,
				blob: git(repo, ["rev-parse", `${after}:${path}`])
					.toString()
					.trim(),
			});
	}
	return findings;
}

export function flagIntegratedCode(options: {
	repo: string;
	before: string;
	after: string;
	source: string;
	dryRun?: boolean;
	changedThrough?: string;
	db?: Database;
	enqueue?: (title: string, description: string) => string;
}): OversizedFile[] {
	const findings = oversizedMergedFiles(
		options.repo,
		options.before,
		options.after,
		options.changedThrough,
	);
	if (options.dryRun || !findings.length) return findings;
	const db = options.db ?? openGovernorDb();
	const project = projectIdentity(options.repo);
	for (const file of findings) {
		const title = `DRY and decompose ${file.path}`;
		const existing = db
			.query(
				"SELECT id FROM work_items WHERE project = ? AND title = ? AND state NOT IN ('DONE', 'SUPERSEDED') LIMIT 1",
			)
			.get(project, title) as { id: string } | null;
		const description = `${file.path} has ${file.lines} lines in merged commit ${options.after}, above the ${CODE_LINE_SOFT_CAP}-line soft cap. Review duplicate patterns (ast-grep), remove duplication and split by responsibility. Put cohesive modules in a purpose-named subdirectory or well-named sibling files and import them from the original entrypoint. Preserve behavior and public interfaces; do not hide code in minified files or unimported fragments. Verify focused tests and all resulting code files at or below ${CODE_LINE_SOFT_CAP} lines.`;
		let work = existing?.id;
		if (!work) {
			if (options.enqueue) work = options.enqueue(title, description);
			else {
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
						options.source,
					],
					{ cwd: options.repo, stdout: "pipe", stderr: "pipe" },
				);
				work =
					result.exitCode === 0
						? result.stdout.toString().match(/\bW\d+(?:\.\d+)*\b/)?.[0]
						: undefined;
				if (!work)
					throw new Error(`Unable to queue decomposition for ${file.path}`);
			}
		}
		const key = `decomposition.${Bun.hash(JSON.stringify([project, file.path])).toString(16)}`;
		const value = JSON.stringify({
			project,
			...file,
			work,
			mergedSha: options.after,
		});
		const previous = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(key) as { value: string } | null;
		if (previous) {
			const prior = JSON.parse(previous.value) as {
				blob?: string;
				work?: string;
			};
			if (prior.blob === file.blob && prior.work === work) continue;
		}
		db.transaction(() => {
			db.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES(?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
			).run(key, value, options.source, Date.now());
			db.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,'code.decomposition-needed',?,?,NULL)",
			).run(Date.now(), options.source, work, value);
		})();
	}
	return findings;
}
