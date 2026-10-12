import { mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

type Result = { code: number; tail: string };
type Options = {
	repo: string;
	callerRepo: string;
	branch: string;
	ladder?: string;
	timeoutMs: number;
};
const MARKERS = "^([<]{7,}|[=]{7,}|[>]{7,}|[|]{7,})([[:space:]].*)?$";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function command(cwd: string, args: string[], timeout = 60_000) {
	const p = Bun.spawnSync(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout,
	});
	return {
		code: p.exitCode ?? 1,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
const fail = (tail: string): Result => ({ code: 1, tail });

/** Inspect Git objects, never mutable checkout files. A clean Git merge can
 * still contain markers committed by a lane; syntax is checked independently. */
function validateTree(repo: string, before: string, tree: string): Result {
	const changed = command(repo, [
		"git",
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=ACMR",
		before,
		tree,
	]);
	if (changed.code !== 0)
		return fail("merge guard: cannot enumerate candidate tree");
	const paths = changed.out.split("\0").filter(Boolean);
	for (let i = 0; i < paths.length; i += 200) {
		const markers = command(repo, [
			"git",
			"grep",
			"-I",
			"-l",
			"-z",
			"-E",
			MARKERS,
			tree,
			"--",
			...paths.slice(i, i + 200),
		]);
		if (markers.code === 0)
			return fail(
				`merge guard: conflict markers in ${markers.out
					.split("\0")
					.filter(Boolean)
					.map((p) => JSON.stringify(p))
					.join(", ")
					.slice(0, 1600)}`,
			);
		if (markers.code !== 1)
			return fail("merge guard: candidate marker scan failed");
	}
	for (const path of paths.filter(
		(p) => SOURCE.test(p) || /\.jsonc?$/i.test(p),
	)) {
		const object = `${tree}:${path}`;
		const size = command(repo, ["git", "cat-file", "-s", object]);
		if (size.code !== 0 || Number(size.out) > MAX_SOURCE_BYTES)
			return fail(`merge guard: cannot safely parse ${JSON.stringify(path)}`);
		const content = command(repo, ["git", "show", object]);
		if (content.code !== 0)
			return fail(`merge guard: cannot read ${JSON.stringify(path)}`);
		try {
			if (
				/\.jsonc$/i.test(path) ||
				/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(path)
			)
				Bun.JSONC.parse(content.out);
			else if (path.endsWith(".json")) JSON.parse(content.out);
			else {
				const loader = /\.tsx$/i.test(path)
					? "tsx"
					: /\.jsx$/i.test(path)
						? "jsx"
						: /\.[cm]?ts$/i.test(path)
							? "ts"
							: "js";
				new Bun.Transpiler({ loader }).transformSync(content.out);
			}
		} catch (error) {
			return fail(
				`merge guard: syntax rejected ${JSON.stringify(path)}: ${String(error).slice(0, 1200)}`,
			);
		}
	}
	return { code: 0, tail: "" };
}

/** Custom ladders may commit immediately. Run them in our detached worktree,
 * validate their committed result, then publish using Git's safe fast-forward.
 * No reset/checkout/abort touches the caller's index or unrelated dirty files. */
export function guardedMerge(options: Options): Result {
	try {
		return mergeCandidate(options);
	} catch (error) {
		return fail(
			`merge guard: preparation failed: ${String(error).slice(0, 1200)}`,
		);
	}
}

function mergeCandidate(options: Options): Result {
	const { repo, callerRepo, branch, ladder, timeoutMs } = options;
	const before = command(repo, ["git", "rev-parse", "HEAD"]);
	if (before.code !== 0)
		return fail("merge guard: cannot resolve integration HEAD");
	const head = before.out.trim();
	// Generated Fleet refs have this shell-safe alphabet. Ref data must never
	// become executable shell code when substituted into an owner template.
	if (branch.startsWith("-") || !/^[\w./-]+$/.test(branch))
		return fail("merge guard: unsupported unsafe ladder branch name");
	const preview = command(
		repo,
		["git", "merge-tree", "--write-tree", head, branch],
		timeoutMs,
	);
	if (preview.code !== 0)
		return fail(
			`merge guard: candidate merge conflicts or failed: ${(preview.err || preview.out).slice(-1600)}`,
		);
	const tree = preview.out.split("\n")[0]?.trim();
	if (!tree || !/^[a-f0-9]{40,64}$/.test(tree))
		return fail("merge guard: invalid candidate tree");
	const preflight = validateTree(repo, head, tree);
	if (preflight.code !== 0) return preflight;
	const dir = join(repo, ".fleet");
	mkdirSync(dir, { recursive: true });
	const scratch = join(
		dir,
		`merge-check-${process.pid}-${crypto.randomUUID()}`,
	);
	const added = command(
		repo,
		["git", "worktree", "add", "--detach", scratch, head],
		timeoutMs,
	);
	if (added.code !== 0)
		return fail(
			`merge guard: cannot prepare isolated integration: ${added.err.slice(-1600)}`,
		);
	try {
		const callerPath = relative(repo, realpathSync(callerRepo));
		if (callerPath.startsWith("..") || callerPath.startsWith("/"))
			return fail(
				"merge guard: ladder caller is outside integration repository",
			);
		const cwd = join(scratch, callerPath);
		const merge = ladder
			? command(
					cwd,
					["/bin/sh", "-c", ladder.split("{branch}").join(branch)],
					timeoutMs,
				)
			: command(
					scratch,
					["git", "merge", "--no-ff", branch, "-m", `Merge ${branch}`],
					timeoutMs,
				);
		if (merge.code !== 0)
			return fail(
				`isolated ladder failed: ${(merge.err || merge.out).slice(-1600)}`,
			);
		const after = command(scratch, ["git", "rev-parse", "HEAD"]);
		if (after.code !== 0)
			return fail("merge guard: cannot resolve ladder result");
		const sha = after.out.trim();
		if (
			command(repo, ["git", "merge-base", "--is-ancestor", head, sha]).code !==
				0 ||
			command(repo, ["git", "merge-base", "--is-ancestor", branch, sha])
				.code !== 0
		)
			return fail(
				"merge guard: ladder result does not contain the base and lane",
			);
		const status = command(scratch, [
			"git",
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);
		if (status.code !== 0 || status.out)
			return fail("merge guard: ladder left uncommitted integration changes");
		const postflight = validateTree(repo, head, sha);
		if (postflight.code !== 0) return postflight;
		if (command(repo, ["git", "rev-parse", "HEAD"]).out.trim() !== head)
			return fail(
				"merge guard: integration HEAD changed during verification; retry",
			);
		const publish = command(
			repo,
			["git", "merge", "--ff-only", "--no-edit", sha],
			timeoutMs,
		);
		return publish.code === 0
			? { code: 0, tail: "" }
			: fail(`merge guard: publication refused: ${publish.err.slice(-1600)}`);
	} catch (error) {
		return fail(
			`merge guard: isolated verification failed: ${String(error).slice(0, 1200)}`,
		);
	} finally {
		// Force applies ONLY to the uniquely named scratch worktree we created.
		command(repo, ["git", "worktree", "remove", "--force", scratch]);
	}
}
