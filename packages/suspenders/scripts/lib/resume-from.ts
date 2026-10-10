// scripts/lib/resume-from.ts — W622 retake knob: transcript resume as a
// dispatch POLICY, never a default. The blam paired eval (bench/paired,
// resume-bounded/resume-long + the pre-registered RESUME_KNOB_RULE)
// measured transcript resume winning ONLY the bounded class, and only
// inside the prompt-cache TTL — so --resume-from <sid> is honored only
// while every fence holds; any miss falls back to the doctrine default
// (fresh lane + capsule) with the reason disclosed. Never a silent cold
// start, never a resume past the fence.
//
// Fences, in order:
// 1. policy    — SUSPENDERS_RESUME_RETAKE=on (default OFF: fresh-lane
//                doctrine stands until an operator flips the knob).
// 2. executor  — claude only: --resume/--fork-session are binary-verified
//                on the claude adapter (W454); no other harness inherits
//                the grammar.
// 3. claim     — the resumed sid must be the sid HOLDING the claim (the
//                retake re-claims as the same sid through work take's
//                CAS — dispatch calls this only for resume?.sid matches);
//                claim_epoch (W609, parked) strengthens this fence on
//                landing, it does not change the shape.
// 4. freshness — the prior transcript's mtime must be inside the cache-
//                TTL window (the exact condition the eval gated its
//                RESUME verdict on): past it the re-read leaves the 0.1×
//                cache-read rate and the eval says the fresh lane wins.
// --fork-session keeps the pass-1 transcript immutable: the retake is a
// NEW session continuing the old context, never an in-place append.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { adapterForExact } from "../../hooks/lib/executors/registry.ts";
import { transcriptPath } from "../../hooks/lib/lane-liveness.ts";

/** Policy flag — the knob is opt-in at the machine level. */
export const RESUME_RETAKE_FLAG = "SUSPENDERS_RESUME_RETAKE";

/** Freshness fence in minutes (the eval's CACHE_TTL_MIN window, rounded
 * to the owner brief's "retakes under 10 min"; env-tunable). */
export const retakeTtlMin = (env: Record<string, string | undefined>): number =>
	Number(env.SUSPENDERS_RETAKE_TTL_MIN ?? 10);

export type ResumeDecision =
	| {
			mode: "resume";
			sid: string;
			/** claude session uuid — the transcript file's stem */
			sessionUuid: string;
			/** args appended to the claude CLI (adapter forkArgs grammar) */
			forkArgs: string[];
	  }
	| { mode: "fresh"; sid?: string; why: string };

/** Resolve the --resume-from request into a spawn decision. `transcriptFor`
 * is injectable for tests; production resolves through lane-liveness's
 * memoized transcript scan. */
export function resolveResumeFrom(
	sid: string | undefined,
	opts: {
		executor: string;
		env: Record<string, string | undefined>;
		now?: number;
		transcriptFor?: (sid: string) => string | null;
	},
): ResumeDecision {
	if (!sid) return { mode: "fresh", why: "no --resume-from requested" };
	if (opts.env[RESUME_RETAKE_FLAG] !== "on")
		return {
			mode: "fresh",
			sid,
			why: `${RESUME_RETAKE_FLAG} is off (doctrine: fresh lane + capsule)`,
		};
	if (opts.executor !== "claude")
		return {
			mode: "fresh",
			sid,
			why: `executor ${opts.executor} has no verified resume grammar`,
		};
	const path = (opts.transcriptFor ?? transcriptPath)(sid);
	if (!path)
		return { mode: "fresh", sid, why: `no transcript found for ${sid}` };
	const ttlMin = retakeTtlMin(opts.env);
	const ageMin = ((opts.now ?? Date.now()) - statSync(path).mtimeMs) / 60_000;
	if (ageMin > ttlMin)
		return {
			mode: "fresh",
			sid,
			why: `transcript stale (${Math.round(ageMin)} min > ${ttlMin} min fence)`,
		};
	const forkArgs = adapterForExact("claude").forkArgs?.(
		basename(path, ".jsonl"),
	);
	if (!forkArgs)
		return { mode: "fresh", sid, why: "claude adapter returned no forkArgs" };
	return {
		mode: "resume",
		sid,
		sessionUuid: basename(path, ".jsonl"),
		forkArgs,
	};
}

/** The knob's dispatch-side helpers: resolve against the lane-registry
 * resume candidate and the operator's --resume-from request, and render
 * the brief disclosure for an honored resume. Kept HERE (not in
 * dispatch-next.ts) under the 1500-line law. */

export const decisionFor = (
	requested: string | undefined,
	resumeSid: string | undefined,
	executor: string,
	env: Record<string, string | undefined> = process.env,
	io: { transcriptFor?: (sid: string) => string | null; now?: number } = {},
): ResumeDecision =>
	resolveResumeFrom(requested === resumeSid ? requested : undefined, {
		executor,
		env,
		...io,
	});

export const resumeBriefLine = (d: ResumeDecision): string[] =>
	d.mode === "resume"
		? [
				`RESUME MODE: this lane resumed ${d.sid}'s transcript (claude --resume --fork-session); the capsule below is context, not the sole hand-off. Fences held: policy on, claude adapter, claim sid match, transcript cache-warm.`,
			]
		: [];
