import { createHash, randomUUID } from "node:crypto";
import type { GovernorStore } from "./govdb-store.ts";
import type { ReviewContext } from "./review-receipt.ts";

interface Request {
	state: "RUNNING" | "DONE" | "ERROR";
	attempts: number;
	leaseUntil: number;
	token: string;
	nextAt: number;
}
export const reviewRequestKey = (
	project: string,
	item: string,
	c: ReviewContext,
): string =>
	`review.request.${createHash("sha256")
		.update(JSON.stringify([project, item, c.commit, c.base, c.instructions]))
		.digest("hex")}`;

export function finishReviewRequest(
	db: GovernorStore,
	key: string,
	token: string,
	failed: boolean,
): void {
	db.transaction(() => {
		const row = db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null;
		if (!row) return;
		const request = JSON.parse(row.value) as Request;
		if (request.token !== token) return;
		request.state = failed ? "ERROR" : "DONE";
		request.leaseUntil = 0;
		request.nextAt =
			Date.now() + Math.min(900_000, 60_000 * 2 ** request.attempts);
		db.query(
			"UPDATE facts SET value = ?, version = version + 1, ts = ? WHERE key = ?",
		).run(JSON.stringify(request), Date.now(), key);
	})();
}

/** One durable lease per exact review context; same-commit FAIL is never
 * retried as a lottery. Only transport errors/expired leases retry, at most3. */
export function scheduleReview(o: {
	db: GovernorStore;
	project: string;
	item: string;
	repo: string;
	context: ReviewContext;
	env?: NodeJS.ProcessEnv;
	spawn?: (args: string[], env: NodeJS.ProcessEnv) => void;
}): string {
	const env = o.env ?? process.env;
	const author = o.db
		.query(
			"SELECT completed_by FROM work_completion_records WHERE project = ? AND item = ? AND commit_sha = ?",
		)
		.get(o.project, o.item, o.context.commit) as {
		completed_by: string;
	} | null;
	if (!author) return "review unavailable: exact completion author missing";
	const pin = author
		? (o.db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${author.completed_by}.model`) as { value: string } | null)
		: null;
	const model = env.SUSPENDERS_REVIEW_MODEL || pin?.value;
	if (!model)
		return "review unavailable: configure SUSPENDERS_REVIEW_MODEL or restore original lane model fact";
	const key = reviewRequestKey(o.project, o.item, o.context);
	const token = randomUUID();
	const now = Date.now();
	const reserved = o.db.transaction(() => {
		const row = o.db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(key) as { value: string } | null;
		const old = row ? (JSON.parse(row.value) as Request) : null;
		if (old?.state === "DONE")
			return "review completed; unresolved findings require repair";
		if (old && old.attempts >= 3)
			return "review retry budget exhausted (3 attempts); explicit repair required";
		if (old && old.leaseUntil > now)
			return `review already running; lease expires ${new Date(old.leaseUntil).toISOString()}`;
		if (old && old.nextAt > now)
			return `review transport retry deferred until ${new Date(old.nextAt).toISOString()}`;
		const count = o.db
			.query(
				"SELECT COUNT(*) AS n FROM facts WHERE source = 'review-scheduler' AND json_extract(value, '$.state') = 'RUNNING' AND json_extract(value, '$.leaseUntil') > ?",
			)
			.get(now) as { n: number };
		const limit = Number(env.SUSPENDERS_REVIEW_CONCURRENCY ?? 2);
		if (!Number.isInteger(limit) || limit < 1)
			return "invalid SUSPENDERS_REVIEW_CONCURRENCY";
		if (count.n >= limit)
			return `review capacity occupied (${count.n}/${limit})`;
		const request: Request = {
			state: "RUNNING",
			attempts: (old?.attempts ?? 0) + 1,
			leaseUntil: now + 25 * 60_000,
			token,
			nextAt: 0,
		};
		o.db
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
			)
			.run(key, JSON.stringify(request), now);
		return true;
	})();
	if (reserved !== true) return reserved;
	const args = [
		process.execPath,
		new URL("../bin/review-lane.ts", import.meta.url).pathname,
		"--item",
		o.item,
		"--project",
		o.project,
		"--executor",
		`buckle:${model}`,
		"--buckle",
		model,
		"--request-key",
		key,
		"--request-token",
		token,
	];
	try {
		if (o.spawn) o.spawn(args, env);
		else {
			const child = Bun.spawn(args, {
				cwd: o.repo,
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			child.unref();
		}
		return `review requested through Buckle (${model})`;
	} catch {
		finishReviewRequest(o.db, key, token, true);
		return "review launch failed; bounded retry retained";
	}
}
