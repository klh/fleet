// review-evals.ts — W1476: incidents become evals (docs/paas-engineering-
// standard-2026-10-23.md:851 — every revert or incident adds a case). The
// merge ladder runs reviewEvalsAfterMerge after each landing, fail-open at
// the call site (merge.ts): a revert or incident landing on main banks one
// `review.incident` event per commit — the C156 seam W1477's review metrics
// read — and mints one deduplicated arena-case work item asking for an
// IncidentDef in the W792 review arena
// (packages/belt/bench/arena/review-incident.ts).
//
// Revert (C156; W1477 keeps a parity copy in packages/belt/bench/
// review-guardrail.ts until the kernel promotion): the body names the
// reverted commit (`This reverts commit <40hex>`) or the subject starts
// `Revert "` (reverts=null on a subject-only match). A revert of a revert
// (`Revert "Revert ` or git >=2.43's `Reapply "`) re-lands the original — no
// incident. Landing time only: a named revert whose target never reached
// main (not an ancestor of the pre-merge head) undoes branch-internal work
// and is dropped.
//
// Incident: the landing's item or an ancestor (parent_id) carries the
// `incident` tag. The case keys on the topmost tagged ancestor, so a
// multi-part fix mints one case; every landing still banks its own event.
import {
	type GovernorStore,
	openStore,
	projectIdentity,
} from "../govdb/govdb.ts";
import { enqueueWorkItem, itemByTitle } from "../work/work-enqueue.ts";
import { splitTags } from "../work/work-tags.ts";

export const REVIEW_INCIDENT_KIND = "review.incident";
export const CASE_TAGS = ["review", "arena-case"];
const ARENA = "packages/belt/bench/arena";

export interface RevertLanding {
	commit: string;
	subject: string;
	reverts: string | null;
}

export interface IncidentRoot {
	id: string;
	title: string;
}

export interface ReviewIncident {
	class: "revert" | "incident";
	/** 40-hex: the revert commit, or the incident landing's merge commit */
	commit: string;
	reverts: string | null;
	subject: string;
	incident: IncidentRoot | null;
}

type Enqueue = (title: string, description: string) => string | undefined;

const git = (repo: string, args: string[]) =>
	Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

const short = (sha: string): string => sha.slice(0, 10);
const clip = (text: string): string =>
	text.length > 90 ? `${text.slice(0, 87)}...` : text;

/** C156 pure classifier: a revert names its target (null when only the
 *  subject says so); null = not a revert, or a re-land. */
export function classifyRevert(
	subject: string,
	body: string,
): { reverts: string | null } | null {
	if (/^(?:Revert "Revert |Reapply ")/.test(subject)) return null;
	const named = /This reverts commit ([0-9a-f]{40})/.exec(body)?.[1];
	if (named) return { reverts: named };
	return /^Revert "/.test(subject) ? { reverts: null } : null;
}

/** Reverts a landing brought onto main, oldest first; branch-internal undos
 *  (the named target was not on main before the merge) are dropped. */
export function revertLandings(
	repo: string,
	before: string,
	after: string,
): RevertLanding[] {
	const log = git(repo, [
		"log",
		"--reverse",
		"--format=%H%x1f%s%x1f%b%x1e",
		`${before}..${after}`,
	]);
	if (log.exitCode !== 0)
		throw new Error(`Unable to read landing ${before}..${after}`);
	const out: RevertLanding[] = [];
	for (const record of log.stdout.toString().split("\x1e")) {
		const [commit = "", subject = "", body = ""] = record
			.trimStart()
			.split("\x1f");
		const hit = commit ? classifyRevert(subject, body) : null;
		if (!hit) continue;
		// exit 1 = definitely not on main; unknown objects stay reverts
		if (
			hit.reverts &&
			git(repo, ["merge-base", "--is-ancestor", hit.reverts, before])
				.exitCode === 1
		)
			continue;
		out.push({ commit, subject, reverts: hit.reverts });
	}
	return out;
}

/** The topmost incident-tagged item on the item's parent chain, or null. */
export function incidentRoot(
	db: GovernorStore,
	project: string,
	item: string,
): IncidentRoot | null {
	let root: IncidentRoot | null = null;
	const seen = new Set<string>();
	let id: string | null = item;
	while (id && !seen.has(id)) {
		seen.add(id);
		const row = db
			.query(
				"SELECT id, title, tags, parent_id FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, id) as {
			id: string;
			title: string;
			tags: string | null;
			parent_id: string | null;
		} | null;
		if (!row) break;
		if (splitTags(row.tags).includes("incident"))
			root = { id: row.id, title: row.title };
		id = row.parent_id;
	}
	return root;
}

/** Arena-case item text: one case per incident root, else per revert. */
export function caseText(
	incident: ReviewIncident,
	work: string | null,
	mergedSha: string,
): { title: string; description: string } {
	const title = incident.incident
		? `Add review-arena case for incident ${incident.incident.id}: ${clip(incident.incident.title)}`
		: `Add review-arena case for revert ${short(incident.commit)}: ${clip(incident.subject)}`;
	const what =
		incident.class === "revert"
			? `Revert ${short(incident.commit)} (${incident.subject})${incident.reverts ? ` undoing ${short(incident.reverts)}` : ""}`
			: `Incident fix ${short(incident.commit)} (${incident.subject})`;
	const description = `${what} landed on main${work ? ` with ${work}` : ""}${incident.incident ? ` under incident ${incident.incident.id}` : ""} (merge ${short(mergedSha)}). Incidents become evals: add an IncidentDef to ${ARENA}/review-incident.ts — sha ${incident.commit} (the fixed state; the arena reviews the reverse diff, which reintroduces the defect), paths = the files that diff touches, one defect per real bug (file + unique anchor in the buggy blob + desc). Then move ${ARENA}/review-seal aside, re-design (bun ${ARENA}/review-run.ts --design) and rescore (--rescore) so the ledger records the score delta. Supersede with the reason when no reviewable defect exists (policy rollback, flaky-test revert).`;
	return { title, description };
}

/** Bank one incident: the review.incident event (deduped on project +
 *  commit) scoped to its arena-case item (deduped on title in any state).
 *  Returns the case id, or null when the commit was already banked. */
export function bankReviewIncident(options: {
	repo: string;
	db: GovernorStore;
	project: string;
	source: string;
	work: string | null;
	mergedSha: string;
	incident: ReviewIncident;
	enqueue?: Enqueue;
}): string | null {
	const { db, project, incident } = options;
	const banked = db
		.query(
			"SELECT 1 AS hit FROM events WHERE kind = ? AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.commit') = ? LIMIT 1",
		)
		.get(REVIEW_INCIDENT_KIND, project, incident.commit);
	if (banked) return null;
	const { title, description } = caseText(
		incident,
		options.work,
		options.mergedSha,
	);
	const work =
		itemByTitle(db, project, title, true) ??
		(options.enqueue
			? options.enqueue(title, description)
			: enqueueWorkItem({
					repo: options.repo,
					title,
					description,
					source: options.source,
					tags: CASE_TAGS,
				}));
	if (!work)
		throw new Error(
			`Unable to queue review-arena case for ${short(incident.commit)}`,
		);
	db.query(
		"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
	).run(
		Date.now(),
		options.source,
		REVIEW_INCIDENT_KIND,
		work,
		JSON.stringify({
			project,
			class: incident.class,
			commit: incident.commit,
			reverts: incident.reverts,
			work: options.work,
			mergedSha: options.mergedSha,
			case: work,
			subject: incident.subject,
			incident: incident.incident?.id ?? null,
		}),
	);
	return work;
}

/** The newest non-merge subject a landing carried (the lane commit). */
function landingSubject(repo: string, before: string, merged: string): string {
	const tip = git(repo, [
		"log",
		"-1",
		"--no-merges",
		"--format=%s",
		`${before}..${merged}`,
	]);
	const subject = tip.exitCode === 0 ? tip.stdout.toString().trim() : "";
	return (
		subject ||
		git(repo, ["log", "-1", "--format=%s", merged]).stdout.toString().trim()
	);
}

/** Merge-ladder entry: bank every revert the landing brought onto main —
 *  or, with none, the landing itself when its item rides an incident.
 *  `landed` is the merge commit before any qlty fix-up. Log lines out. */
export function reviewEvalsAfterMerge(options: {
	repo: string;
	item: string | undefined;
	before: string;
	landed: string;
	source: string;
	db?: GovernorStore;
	enqueue?: Enqueue;
}): string[] {
	const head = git(options.repo, ["rev-parse", "--verify", options.landed]);
	if (head.exitCode !== 0)
		throw new Error(`Unable to resolve landing ${options.landed}`);
	const merged = head.stdout.toString().trim();
	const db = options.db ?? openStore();
	try {
		const project = projectIdentity(options.repo);
		const root = options.item ? incidentRoot(db, project, options.item) : null;
		const reverts = revertLandings(options.repo, options.before, merged);
		const incidents: ReviewIncident[] = reverts.length
			? reverts.map((r) => ({ class: "revert" as const, ...r, incident: root }))
			: root
				? [
						{
							class: "incident",
							commit: merged,
							reverts: null,
							subject: landingSubject(options.repo, options.before, merged),
							incident: root,
						},
					]
				: [];
		const lines: string[] = [];
		for (const incident of incidents) {
			const work = bankReviewIncident({
				repo: options.repo,
				db,
				project,
				source: options.source,
				work: options.item ?? null,
				mergedSha: merged,
				incident,
				enqueue: options.enqueue,
			});
			if (work)
				lines.push(
					`REVIEW-INCIDENT ${incident.class} ${short(incident.commit)} → arena case ${work}`,
				);
		}
		return lines;
	} finally {
		if (!options.db) db.close();
	}
}
