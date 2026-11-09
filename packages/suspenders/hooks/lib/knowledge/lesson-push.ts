// hooks/lib/knowledge/lesson-push.ts — W2779.3.1: the session-start lesson
// push as a thin client. Sink-first: lesson.* rows come from the fk sink's
// /knowledge/sql face (bksk_ READ_ key) when the sink conf resolves; the
// fleet-local knowledge.db read (knowledge-facts.ts) is the compatibility
// fallback (seam doc compatibility law — the retarget completes as a conf
// flip). Fail-open: any sink error degrades to the local read; a local
// store unreadable → empty (no lesson push this session, as before).
import { listKnowledgeFacts, withKnowledgeFacts } from "./knowledge-facts.ts";
import {
	lessonsViaSink,
	sinkConf,
	type SinkLessonRow,
} from "@klh/fleet-knowledge/src/knowledge-sink-client.ts";

export interface LessonPushRow {
	key: string;
	value: string;
	ts: number;
}

/** The lesson rows a session-start push renders: sink-first, local
 *  fallback. Never throws. */
export async function lessonsForPush(
	opts: { since: number; limit?: number },
	env: NodeJS.ProcessEnv = process.env,
	fetchFn: typeof fetch = fetch,
): Promise<{ rows: LessonPushRow[]; via: "sink" | "local" }> {
	const sink = await lessonsViaSink(
		{ since: opts.since, limit: opts.limit },
		sinkConfOf(env),
		fetchFn,
	);
	if (sink.ok) return { rows: sink.rows, via: "sink" };
	return { rows: localLessons(opts), via: "local" };
}

function sinkConfOf(env: NodeJS.ProcessEnv) {
	// imported lazily to keep the module graph flat for the test harness —
	// sinkConf is a pure env read; direct import keeps types honest.
	return sinkConf(env);
}

/** The compatibility fallback: the fleet-local knowledge.db read. */
function localLessons(opts: {
	since: number;
	limit?: number;
}): LessonPushRow[] {
	try {
		return withKnowledgeFacts((kb) =>
			listKnowledgeFacts(kb, {
				prefixes: ["lesson."],
				since: opts.since,
				order: "ts",
				limit: opts.limit ?? 5,
			}),
		).map((r: SinkLessonRow) => ({
			key: r.key,
			value: r.value ?? "",
			ts: r.ts,
		}));
	} catch {
		return []; // knowledge store unreadable: no lesson push this session
	}
}

/** Render the push lines — value truncated, full note one fact-get away. */
export function lessonPushLines(rows: LessonPushRow[]): string[] {
	const out: string[] = [];
	for (const r of rows) {
		const v =
			r.value.length > 200
				? `${r.value.slice(0, 200)}… (coord fact get ${r.key})`
				: r.value;
		out.push(`LESSON ${r.key.slice("lesson.".length)}: ${v}`);
	}
	return out;
}
