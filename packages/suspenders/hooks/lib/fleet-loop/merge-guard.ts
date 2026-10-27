import { mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import {
	addedDiffLines,
	findingsText,
	scrubAddedLines,
	scrubRules,
} from "../gates/scrub.ts";
import { binaryPaths, blobFindings } from "../gates/scrub-git.ts";
import { TEST_FILE, testRelocationDelta } from "./merge-guard-relocation.ts";

type Result = { code: number; tail: string };
type Options = {
	repo: string;
	callerRepo: string;
	branch: string;
	ladder?: string;
	timeoutMs: number;
	verifyReview?: (candidate?: string) => { ok: boolean; why: string };
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
	const deleted = command(repo, [
		"git",
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=D",
		before,
		tree,
	]);
	if (deleted.code !== 0)
		return fail("merge guard: cannot enumerate candidate deletions");
	const deletedCount = deleted.out.split("\0").filter(Boolean).length;
	if (deletedCount > 20)
		return fail(`merge guard: candidate deletes ${deletedCount} tracked files`);
	const changedLines = command(repo, [
		"git",
		"diff",
		"--numstat",
		"--diff-filter=M",
		before,
		tree,
	]);
	if (changedLines.code !== 0)
		return fail("merge guard: cannot measure candidate file loss");
	// W1302.4.1: a lib EXTRACTION shrinks its source file while the moved
	// lines reappear in an added file the M-filter never sees (262 removed /
	// 4 added tripped three false FAILs on W1302.4). Lines an ADDED file in
	// the same delta carries are moves, not loss.
	const rows = changedLines.out
		.split("\n")
		.map((line) => line.split("\t"))
		.filter((row) => row.length === 3 && row[2]);
	const shrunk = rows.filter(
		([added, removed]) =>
			Number(removed) >= 200 && Number(removed) >= Number(added) * 10,
	);
	const movedIntoAdded = movedLinesIntoAddedFiles(
		repo,
		before,
		tree,
		shrunk.map((row) => row[2]),
	);
	for (const [added, removed, path] of rows) {
		const addCount = Number(added);
		const loss = Number(removed) - (movedIntoAdded.get(path) ?? 0);
		if (loss >= 200 && loss >= addCount * 10) {
			if (!TEST_FILE.test(path))
				return fail(
					`merge guard: candidate removes ${loss} lines from ${JSON.stringify(path)} with only ${addCount} added`,
				);
			// W1216.2.1: mass line loss on a test file is allowed ONLY as a
			// proven STRUCTURAL relocation — every removed (name, body) pair
			// must reappear verbatim candidate-wide and existing helper
			// evidence must persist unmodified. Names are not proof; erosion
			// keeps the original verdict.
			const reloc = testRelocationDelta(repo, before, tree);
			if (!reloc.balanced)
				return fail(
					`merge guard: candidate removes ${loss} lines from ${JSON.stringify(path)} with only ${addCount} added — test relocation unproven: ${reloc.why}`,
				);
		}
	}
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
	// W694 H1: the merge ladder publishes via `merge --no-ff` + `--ff-only` in
	// a scratch worktree — the Bash scrub gate never sees it. Scan the whole
	// candidate delta (added lines vs integration HEAD) before publication.
	if (process.env.SUSPENDERS_SCRUB !== "0") {
		const d = command(repo, [
			"git",
			"diff",
			`${before}..${tree}`,
			"-U0",
			"--no-color",
		]);
		if (d.code !== 0) return fail("merge guard: candidate scrub scan failed");
		const found = scrubAddedLines(addedDiffLines(d.out), scrubRules());
		if (found.length > 0)
			return fail(
				`merge guard: scrub findings in candidate merge tree:\n${findingsText(found)}`,
			);
		// binary candidates: numstat names them (`- -` rows), the candidate
		// tree's blob scans whole (W708 — NUL-laced leaks previously sailed)
		const nd = command(repo, [
			"git",
			"diff",
			"--numstat",
			`${before}..${tree}`,
		]);
		if (nd.code !== 0) return fail("merge guard: candidate binary scan failed");
		const bin = binaryPaths(nd.out).flatMap((p) =>
			blobFindings(repo, `${tree}:${p}`, p),
		);
		if (bin.length > 0)
			return fail(
				`merge guard: scrub findings in candidate binary files:\n${findingsText(bin)}`,
			);
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

// W1302.4.1: per candidate path, how many of its removed lines an ADDED
// file in the same delta carries verbatim — an extraction's moved lines
// are not loss (262 removed / 4 added on W1302.4 were moves into a new
// lib the M-filter never saw). Enumerates added source blobs only when a
// shrink candidate exists; oversized blobs are skipped, never parsed.
function movedLinesIntoAddedFiles(
	repo: string,
	before: string,
	tree: string,
	candidates: string[],
): Map<string, number> {
	const moved = new Map<string, number>();
	if (!candidates.length) return moved;
	const added = command(repo, [
		"git",
		"diff",
		"--numstat",
		"--diff-filter=A",
		before,
		tree,
	]);
	if (added.code !== 0) return moved;
	const addedPaths: string[] = [];
	for (const line of added.out.split("\n")) {
		const [a, r, p] = line.split("\t");
		if (a === "-" || r === "-" || !p || !SOURCE.test(p)) continue;
		addedPaths.push(p);
	}
	if (!addedPaths.length || addedPaths.length > 200) return moved;
	const available = new Map<string, number>();
	for (const path of addedPaths) {
		const object = `${tree}:${path}`;
		const size = command(repo, ["git", "cat-file", "-s", object]);
		if (size.code !== 0 || Number(size.out) > MAX_SOURCE_BYTES) continue;
		const content = command(repo, ["git", "show", object]);
		if (content.code !== 0) continue;
		const lines = content.out.split("\n");
		if (content.out.endsWith("\n")) lines.pop();
		for (const line of lines)
			available.set(line, (available.get(line) ?? 0) + 1);
	}
	if (!available.size) return moved;
	for (const path of candidates) {
		const d = command(repo, [
			"git",
			"diff",
			"-U0",
			"--no-color",
			before,
			tree,
			"--",
			path,
		]);
		const at = d.out.indexOf("\n@@");
		if (d.code !== 0 || at < 0) continue;
		const removed = d.out
			.slice(at)
			.split("\n")
			.filter((l) => l.startsWith("-") && !l.startsWith("---"))
			.map((l) => l.slice(1));
		let count = 0;
		for (const line of removed) {
			const remaining = available.get(line) ?? 0;
			if (remaining < 1) continue;
			available.set(line, remaining - 1);
			count += 1;
		}
		if (count) moved.set(path, count);
	}
	return moved;
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
	const review = options.verifyReview?.();
	if (review && !review.ok) return fail(`review required: ${review.why}`);
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
		const finalReview = options.verifyReview?.(sha);
		if (finalReview && !finalReview.ok)
			return fail(`review required: ${finalReview.why}`);
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
