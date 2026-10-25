import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { emitStoredEvent } from "../../coord/event-publish.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";

export interface ReviewContext {
	repo: string;
	commit: string;
	base: string;
	instructions: Record<string, string>;
	text: string;
}
export interface ReviewReceipt {
	version: 1;
	commit: string;
	base: string;
	instructions: Record<string, string>;
	reviewer: string;
	verdict: "PASS" | "FAIL" | "ERROR";
	blocking: string[];
	resolved?: string[];
	evidence: string;
}
const git = (repo: string, args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`review context: git ${args[0]} failed`);
	return p.stdout.toString();
};
const hash = (s: string): string =>
	createHash("sha256").update(s).digest("hex");
const instructionAtTree = (
	repo: string,
	tree: string,
	path: string,
): { digest: string; body: string; size: number } => {
	const entry = git(repo, ["ls-tree", "-z", tree, "--", path]);
	if (!entry) return { digest: "absent", body: "", size: 0 };
	if (!/^100(?:644|755) blob /.test(entry))
		throw new Error(`review instruction must be a regular file: ${path}`);
	const object = `${tree}:${path}`;
	const size = Number(git(repo, ["cat-file", "-s", object]).trim());
	if (!Number.isSafeInteger(size) || size > 131_072)
		throw new Error("review instructions exceed bounded context budget");
	const body = git(repo, ["show", object]);
	return { digest: hash(body), body, size };
};
const previewTree = (repo: string, base: string, commit: string): string =>
	git(repo, ["merge-tree", "--write-tree", base, commit]).split("\n")[0].trim();
const changedPaths = (repo: string, before: string, after: string): string[] =>
	git(repo, ["diff", "--name-only", "-z", "--no-renames", before, after])
		.split("\0")
		.filter(Boolean)
		.map((path) => {
			if (path.includes("\uFFFD"))
				throw new Error("review path is not valid UTF-8");
			return path;
		});
const isAncestor = (repo: string, before: string, after: string): boolean =>
	Bun.spawnSync(["git", "merge-base", "--is-ancestor", before, after], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode === 0;

/** A disjoint file may still change how the reviewed files build, load, or
 * test. Treat configuration and automation inputs as shared dependencies. */
const isSharedReviewInput = (path: string): boolean => {
	const parts = path.split("/");
	const name = parts.at(-1) ?? "";
	return (
		parts
			.slice(0, -1)
			.some((part) =>
				[
					".github",
					".githooks",
					".qlty",
					"build",
					"config",
					"scripts",
				].includes(part),
			) ||
		/\.(?:json|jsonc|ya?ml|toml|lock|lockb)$/.test(name) ||
		/(?:^|[.-])(?:build|config|lint|setup|workspace)(?:[.-]|$)/i.test(name) ||
		[
			".npmrc",
			".yarnrc",
			".pnp.cjs",
			"Gemfile",
			"go.mod",
			"go.sum",
			"requirements.txt",
		].includes(name) ||
		/^(?:Dockerfile|Makefile|Procfile|justfile)$/.test(name) ||
		/\.(?:sh|bash)$/.test(name)
	);
};

/** An old review may survive only when Git proves the candidate's merged
 * effect is unchanged. Path disjointness is a conservative structural proof,
 * not a proof of independence between modules. */
const unchangedReviewedEffect = (
	repo: string,
	oldBase: string,
	base: string,
	commit: string,
): { ok: boolean; preview: string } => {
	if (!/^[0-9a-f]{40,64}$/.test(oldBase) || !isAncestor(repo, oldBase, base))
		return { ok: false, preview: "" };
	const oldPreview = previewTree(repo, oldBase, commit);
	const preview = previewTree(repo, base, commit);
	const shared = git(repo, ["merge-base", base, commit]).trim();
	if (
		oldPreview === preview &&
		git(repo, ["rev-parse", `${base}^{tree}`]).trim() ===
			git(repo, ["rev-parse", `${shared}^{tree}`]).trim()
	)
		return { ok: true, preview };
	const candidatePaths = changedPaths(repo, oldBase, oldPreview);
	const advancePaths = new Set(changedPaths(repo, oldBase, base));
	if (
		!candidatePaths.length ||
		[...advancePaths].some(isSharedReviewInput) ||
		candidatePaths.some((path) => advancePaths.has(path))
	)
		return { ok: false, preview };
	const unchanged =
		git(repo, [
			"diff",
			"--binary",
			"--no-ext-diff",
			"--no-renames",
			oldBase,
			oldPreview,
			"--",
			...candidatePaths,
		]) ===
		git(repo, [
			"diff",
			"--binary",
			"--no-ext-diff",
			"--no-renames",
			base,
			preview,
			"--",
			...candidatePaths,
		]);
	return { ok: unchanged, preview };
};

// W1243.1.1.1: a B-ID on a non-RESOLVED line is a *mention*, not
// automatically a live blocker. A standalone `RESOLVED: B<id> <evidence>`
// line, with an optional list bullet, is the reviewer's explicit resolution and subtracts the ID from
// blocking; an unresolved mention stays blocking (fail-closed) and the
// prior-blocker guard below still demands the explicit RESOLVED line.
const RESOLVED_LINE =
	/^[ \t]*(?:[-*][ \t]+)?RESOLVED:\s+(B\d+-[a-zA-Z0-9-]+)\s+\S.+$/gm;
const MENTION = /\bB\d+-[a-zA-Z0-9-]+/g;

export const reviewFindingIds = (
	text: string,
): { blocking: string[]; resolved: string[] } => {
	const resolved = [...text.matchAll(RESOLVED_LINE)].map((m) => m[1]);
	const resolvedSet = new Set(resolved);
	const blocking = [
		...new Set(
			text
				.split("\n")
				.filter((line) => !/^[ \t]*(?:[-*][ \t]+)?RESOLVED:/.test(line))
				.flatMap((line) => line.match(MENTION) ?? []),
		),
	].filter((id) => !resolvedSet.has(id));
	return { blocking, resolved };
};

/** The short item thread can cut an ERROR note before its B-ID. Supply the
 * reviewer with the receipt's exact-commit blockers so a later PASS can
 * explicitly resolve them instead of starving the merge gate. */
export function priorBlockingReviewLines(
	db: GovernorStore,
	project: string,
	item: string,
	commit: string,
): string[] {
	const events = db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND CASE WHEN json_valid(json_extract(payload, '$.receipt')) THEN json_extract(json_extract(payload, '$.receipt'), '$.commit') ELSE NULL END = ? ORDER BY id DESC LIMIT 100",
		)
		.all(project, item, commit) as { payload: string }[];
	if (events.length === 100)
		throw new Error("exact-commit review history exceeds bounded audit");
	const byId = new Map<string, string>();
	for (const event of events) {
		let receipt: ReviewReceipt;
		try {
			receipt = JSON.parse(JSON.parse(event.payload).receipt);
		} catch {
			continue;
		}
		if (!Array.isArray(receipt.blocking)) continue;
		for (const id of receipt.blocking) {
			if (typeof id !== "string" || !/^B\d+-[a-zA-Z0-9-]+$/.test(id)) continue;
			if (!byId.has(id)) {
				const evidence = String(receipt.evidence ?? "")
					.slice(-500)
					.replace(/\s+/g, " ")
					.trim();
				byId.set(id, evidence);
			}
		}
		if (byId.size > 32)
			throw new Error("too many prior blocking findings for review prompt");
	}
	return [...byId].map(([id, evidence]) => `${id}: ${evidence}`);
}

/** Read instructions from immutable candidate Git objects, including absent
 * files so adding a package instruction invalidates an earlier approval. */
export function reviewContext(
	repo: string,
	branch: string,
	baseRef = "HEAD",
): ReviewContext {
	const commit = git(repo, [
		"rev-parse",
		"--verify",
		`${branch}^{commit}`,
	]).trim();
	const base = git(repo, [
		"rev-parse",
		"--verify",
		`${baseRef}^{commit}`,
	]).trim();
	const paths = git(repo, ["diff", "--name-only", "-z", `${base}...${commit}`])
		.split("\0")
		.filter(Boolean);
	const names = new Set(["AGENTS.md", "REVIEW.md", "how-to-review.md"]);
	for (const path of paths) {
		let dir = dirname(path);
		while (dir !== ".") {
			names.add(`${dir}/AGENTS.md`);
			names.add(`${dir}/REVIEW.md`);
			dir = dirname(dir);
		}
	}
	const preview = previewTree(repo, base, commit);
	const instructions: Record<string, string> = {};
	const text: string[] = [];
	let instructionBytes = 0;
	for (const path of [...names].sort()) {
		const instruction = instructionAtTree(repo, preview, path);
		instructionBytes += instruction.size;
		if (instructionBytes > 524_288)
			throw new Error("review instructions exceed bounded context budget");
		instructions[path] = instruction.digest;
		if (instruction.digest !== "absent")
			text.push(
				`INSTRUCTION ${path} (sha256 ${instruction.digest}):\n${instruction.body}`,
			);
	}
	return { repo, commit, base, instructions, text: text.join("\n\n") };
}

export function publishReviewReceipt(
	db: GovernorStore,
	project: string,
	item: string,
	receipt: ReviewReceipt,
): number {
	const session = db
		.query("SELECT sid FROM sessions WHERE sid = ? AND project = ?")
		.get(receipt.reviewer, project);
	if (!session)
		throw new Error("review receipt requires a registered reviewer session");
	return emitStoredEvent(db, project, {
		kind: "work.review",
		scope: item,
		source: receipt.reviewer,
		note: receipt.evidence,
		extra: {
			work: item,
			verdict: receipt.verdict,
			receipt: JSON.stringify(receipt),
		},
	});
}

/** Existing events are the durable contract. Old unbound second opinions
 * remain readable but cannot approve a merge. Latest bound verdict wins. */
export function checkReviewReceipt(
	db: GovernorStore,
	project: string,
	item: string,
	context: ReviewContext,
): { ok: boolean; why: string; event?: number } {
	const author = db
		.query(
			"SELECT completed_by FROM work_completion_records WHERE project = ? AND item = ? AND commit_sha = ?",
		)
		.get(project, item, context.commit) as { completed_by: string } | null;
	if (!author) return { ok: false, why: "exact completion author unavailable" };
	const events = db
		.query(
			"SELECT id, source, payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND CASE WHEN json_valid(json_extract(payload, '$.receipt')) THEN json_extract(json_extract(payload, '$.receipt'), '$.commit') ELSE NULL END = ? ORDER BY id DESC LIMIT 100",
		)
		.all(project, item, context.commit) as {
		id: number;
		source: string;
		payload: string;
	}[];
	if (events.length === 100)
		return {
			ok: false,
			why: "exact-commit review history exceeds bounded audit",
		};
	for (const event of events) {
		let r: ReviewReceipt;
		try {
			r = JSON.parse(JSON.parse(event.payload).receipt);
		} catch {
			continue;
		}
		if (r.version !== 1 || r.commit !== context.commit) continue;
		if (r.reviewer !== event.source || r.reviewer === author.completed_by)
			return {
				ok: false,
				why: "review is not independent of completion author",
			};
		if (
			!db
				.query("SELECT sid FROM sessions WHERE sid = ? AND project = ?")
				.get(r.reviewer, project)
		)
			return { ok: false, why: "reviewer session unavailable" };
		let bindingValid = false;
		try {
			if (r.base === context.base) {
				bindingValid =
					JSON.stringify(r.instructions) ===
					JSON.stringify(context.instructions);
			} else if (
				r.instructions &&
				typeof r.instructions === "object" &&
				Object.keys(r.instructions).length <= 512
			) {
				const proof = unchangedReviewedEffect(
					context.repo,
					r.base,
					context.base,
					context.commit,
				);
				if (proof.ok) {
					let instructionBytes = 0;
					bindingValid = Object.keys(context.instructions).every((path) =>
						Object.hasOwn(r.instructions, path),
					);
					for (const [path, digest] of Object.entries(r.instructions)) {
						const current = instructionAtTree(
							context.repo,
							proof.preview,
							path,
						);
						instructionBytes += current.size;
						if (instructionBytes > 524_288 || current.digest !== digest) {
							bindingValid = false;
							break;
						}
					}
				}
			}
		} catch {
			bindingValid = false;
		}
		if (!bindingValid)
			return {
				ok: false,
				why: "review is stale: base or applicable instructions changed",
			};
		if (
			r.verdict !== "PASS" ||
			!Array.isArray(r.blocking) ||
			(r.resolved !== undefined && !Array.isArray(r.resolved)) ||
			r.blocking.length > 0 ||
			!r.evidence?.trim()
		)
			return {
				ok: false,
				why: "review has unresolved blocking findings or no passing evidence",
			};
		for (const prior of events.filter((e) => e.id < event.id)) {
			try {
				const old = JSON.parse(
					JSON.parse(prior.payload).receipt,
				) as ReviewReceipt;
				if (
					old.commit === context.commit &&
					old.blocking.some((id) => !r.resolved?.includes(id))
				)
					return {
						ok: false,
						why: "earlier blocking findings require explicit reviewer resolution",
					};
			} catch {
				/* Legacy unbound review cannot establish finding identity. */
			}
		}
		return { ok: true, why: "", event: event.id };
	}
	return {
		ok: false,
		why: "independent review receipt missing for exact commit",
	};
}

/** DONE is not landing. Only real ancestry in the integration checkout can
 * publish this idempotent receipt; failed publication remains retryable. */
export function recordLanding(
	db: GovernorStore,
	repo: string,
	project: string,
	item: string,
	branch: string,
	commit: string,
): number {
	const completion = db
		.query(
			"SELECT state, result_sha FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, item) as { state: string; result_sha: string } | null;
	if (completion?.state !== "DONE" || completion.result_sha !== commit)
		throw new Error("landing requires the exact DONE result commit");
	const head = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	git(repo, ["merge-base", "--is-ancestor", commit, head]);
	return db.transaction(() => {
		const previous = db
			.query(
				"SELECT id FROM events WHERE kind = 'work.landed' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.commit') = ? LIMIT 1",
			)
			.get(project, item, commit) as { id: number } | null;
		if (previous) return previous.id;
		return emitStoredEvent(db, project, {
			kind: "work.landed",
			source: "fleet-loop",
			scope: branch,
			sha: head,
			extra: {
				work: item,
				branch,
				commit,
				integration: head,
				verification: "git-ancestor",
			},
		});
	})();
}
