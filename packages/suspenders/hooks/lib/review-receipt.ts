import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { GovernorStore } from "./govdb-store.ts";
import { emitStoredEvent } from "../coord/event-publish.ts";

export interface ReviewContext {
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
	const preview = git(repo, ["merge-tree", "--write-tree", base, commit])
		.split("\n")[0]
		.trim();
	const instructions: Record<string, string> = {};
	const text: string[] = [];
	let instructionBytes = 0;
	for (const path of [...names].sort()) {
		const entry = git(repo, ["ls-tree", "-z", preview, "--", path]);
		if (!entry) {
			instructions[path] = "absent";
			continue;
		}
		if (!/^100(?:644|755) blob /.test(entry))
			throw new Error(`review instruction must be a regular file: ${path}`);
		const object = `${preview}:${path}`;
		const size = Number(git(repo, ["cat-file", "-s", object]).trim());
		instructionBytes += size;
		if (
			!Number.isSafeInteger(size) ||
			size > 131_072 ||
			instructionBytes > 524_288
		)
			throw new Error("review instructions exceed bounded context budget");
		const body = git(repo, ["show", object]);
		instructions[path] = hash(body);
		text.push(`INSTRUCTION ${path} (sha256 ${instructions[path]}):\n${body}`);
	}
	return { commit, base, instructions, text: text.join("\n\n") };
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
		if (
			r.base !== context.base ||
			JSON.stringify(r.instructions) !== JSON.stringify(context.instructions)
		)
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
