// review-lane-arm.ts — W1476: the review LANE as a third arena arm. Arms A/B
// measure the oracle frame and the how-to-review pipeline; this arm measures
// what the lane itself sends: its exact prompt builder and OpenAI-wire leg
// request, loaded at run time from the suspenders module named by
// review-surface.json `lanePlugin` (a config path + dynamic import — the
// loadCondenser idiom, no static belt→suspenders edge), riding the review
// model pin the suspenders rescore runner resolves and passes as env
// (REVIEW_LANE_URL / REVIEW_LANE_MODEL / REVIEW_LANE_KEY — a minted scoped
// buckle key, never typed). One pass, scored by the shared arena contract.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha, stripThink } from "./core.ts";
import { MAX_ROUNDS, type ReviewTask } from "./review-core.ts";
import { parseFindings, parseVerdictLine } from "./review-parse.ts";
import type { ArmRun } from "./review-pipeline.ts";

/** One lane leg reply (the plugin's ReviewLegReply). */
export interface LaneReply {
	text: string;
	model?: string;
	inTok: number;
	outTok: number;
}

/** the lane prompt for one arena task */
export type LanePrompter = (task: ReviewTask) => string;
/** the lane's OpenAI-wire review call */
export type LaneRequest = (o: {
	url: string;
	model: string;
	key?: string;
	prompt: string;
	timeoutMs: number;
}) => Promise<LaneReply>;

export interface LanePlugin {
	prompter: LanePrompter;
	request: LaneRequest;
	/** `<file>@<sha8>` of the loaded module */
	version: string;
}

export interface LaneLeg {
	url: string;
	model: string;
	key?: string;
}

// review-lane.ts LEG_TIMEOUT_MS — arm parity
const LANE_TIMEOUT_MS = 15 * 60_000;

/** Load the lane plugin (`root`-relative path): it must export
 *  arenaReviewPrompter(root) and requestReviewLeg. */
export async function loadLanePlugin(
	root: string,
	path: string,
): Promise<LanePlugin> {
	const file = join(root, path);
	const mod = (await import(file)) as {
		arenaReviewPrompter?: unknown;
		requestReviewLeg?: unknown;
	};
	if (
		typeof mod.arenaReviewPrompter !== "function" ||
		typeof mod.requestReviewLeg !== "function"
	)
		throw new Error(
			`lane plugin ${path}: needs arenaReviewPrompter + requestReviewLeg exports`,
		);
	const prompterFor = mod.arenaReviewPrompter as (
		root: string,
	) => LanePrompter;
	return {
		prompter: prompterFor(root),
		request: mod.requestReviewLeg as LaneRequest,
		version: `${path.split("/").pop()}@${sha(readFileSync(file, "utf8")).slice(0, 8)}`,
	};
}

/** The lane leg the rescore runner configured; null = no lane leg. */
export function laneLeg(
	env: Record<string, string | undefined> = process.env,
): LaneLeg | null {
	const url = env.REVIEW_LANE_URL;
	const model = env.REVIEW_LANE_MODEL;
	if (!url || !model) return null;
	return { url, model, key: env.REVIEW_LANE_KEY || undefined };
}

const portOf = (url: string): number => {
	try {
		return Number(new URL(url).port) || 0;
	} catch {
		return 0;
	}
};

/** The lane arm on one task: one call, no rounds (the lane reviews once per
 *  commit; repair rounds are new commits). */
export async function armLane(
	task: ReviewTask,
	plugin: LanePlugin,
	leg: LaneLeg,
): Promise<ArmRun> {
	const t0 = performance.now();
	let reply: LaneReply | null = null;
	let err: string | undefined;
	try {
		reply = await plugin.request({
			url: leg.url,
			model: leg.model,
			key: leg.key,
			prompt: plugin.prompter(task),
			timeoutMs: LANE_TIMEOUT_MS,
		});
	} catch (error) {
		err = error instanceof Error ? error.message : String(error);
	}
	const ms = Math.round(performance.now() - t0);
	const text = reply ? stripThink(reply.text) : "";
	const verdict = reply ? parseVerdictLine(text).verdict : "FAIL";
	const inTok = reply?.inTok ?? 0;
	const outTok = reply?.outTok ?? 0;
	return {
		arm: "lane",
		findings: reply ? parseFindings(text) : [],
		verdict,
		roundsToPass: verdict === "PASS" ? 1 : MAX_ROUNDS + 1,
		openBlockers: [],
		tokIn: inTok,
		tokOut: outTok,
		calls: 1,
		wallMs: ms,
		trace: [
			{
				type: "call",
				leg: "lane-review",
				round: 1,
				port: portOf(leg.url),
				ok: reply !== null,
				ms,
				inTok,
				outTok,
				err,
			},
		],
		ok: reply !== null,
		err,
	};
}
