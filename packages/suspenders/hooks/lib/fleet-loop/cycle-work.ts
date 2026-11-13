import { z } from "zod";
import { join } from "node:path";
import type { MergeReceipt } from "./merge.ts";
import {
	confirmCursor,
	markMaybeRan,
	readCursor,
	readPending,
} from "./sweep-state.ts";

/** Resume after the last attempted branch even if the watchdog interrupted it or it was retired. */
export function runMergePass(options: {
	repo: string;
	branches: string[];
	merge: (branch: string) => MergeReceipt;
	log: (line: string) => void;
}) {
	const path = join(options.repo, ".fleet/merge-cycle.json");
	const bookmark = readPending(path)?.runId ?? readCursor(path)?.runId;
	const branches = [...new Set(options.branches)].sort();
	const next = bookmark ? branches.findIndex((branch) => branch > bookmark) : 0;
	const start = Math.max(0, next);
	const ordered = [...branches.slice(start), ...branches.slice(0, start)];
	let attempted = 0;
	for (const branch of ordered) {
		if (!markMaybeRan(path, branch)) {
			options.log(
				`MERGE-SWEEP deferred: cannot bank attempt cursor; attempted=${attempted}`,
			);
			break;
		}
		options.merge(branch);
		attempted++;
		if (!confirmCursor(path, Date.now(), branch)) {
			options.log(
				`MERGE-SWEEP deferred: cannot confirm cursor; attempted=${attempted}`,
			);
			break;
		}
	}
	return { attempted };
}

export const DispatchOutcomeSchema = z.strictObject({
	status: z.enum(["completed", "failed", "error"]),
	code: z.number().int().nullable(),
	durationMs: z.number().int().nonnegative(),
	target: z.number().int().nonnegative().nullable(),
	configuredTarget: z.number().int().nonnegative(),
	targetSource: z.enum(["central", "template"]),
	admitted: z.null(),
});

/** Exit success is not an admission count. Child output and owner templates never enter logs. */
export function runCycleDispatch(options: {
	template: string;
	target: number;
	timeoutMs: number;
	run: (
		template: string,
		branch: string,
		timeoutMs: number,
	) => { code: number; tail: string };
	log: (line: string) => void;
	now?: () => number;
}) {
	const {
		template,
		target,
		timeoutMs,
		run,
		log,
		now = () => performance.now(),
	} = options;
	const explicit = template.includes("--target");
	const started = now();
	log(
		`DISPATCH-START configuredTarget=${target} targetSource=${explicit ? "template" : "central"}`,
	);
	let code: number | null = null;
	try {
		code = run(
			explicit ? template : `${template} --target ${target}`,
			"",
			timeoutMs,
		).code;
	} catch {
		/* fixed outcome below; arbitrary command errors may contain credentials */
	}
	const outcome = DispatchOutcomeSchema.parse({
		status: code === null ? "error" : code === 0 ? "completed" : "failed",
		code,
		durationMs: Math.max(0, Math.round(now() - started)),
		target: explicit ? null : target,
		configuredTarget: target,
		targetSource: explicit ? "template" : "central",
		admitted: null,
	});
	log(`DISPATCH ${JSON.stringify(outcome)}`);
	return outcome;
}
