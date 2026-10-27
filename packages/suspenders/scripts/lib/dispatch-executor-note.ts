// scripts/lib/dispatch-executor-note.ts — W1353: dispatch discloses the executor + model a lane launched with and warns when a quoted .prefer never reached the executor chain.
import type { PreferDecision } from "./exec-chain.ts";
import type { PreferRouting } from "./prefer-routing.ts";

// every launch pins a model: an unpinned lane inherits the owner's global settings.json model and dies on client-side unrecognized_model
export const DEFAULT_LANE_MODEL = "glm-5.3-flash";

export const laneModelOf = (pick: { model?: string | null }): string =>
	pick.model ?? DEFAULT_LANE_MODEL;

type PreferenceView = Pick<PreferDecision, "source" | "directive" | "line">;

export type ChosenPick = {
	bin: string;
	model?: string | null;
	preference: PreferenceView;
};

export type ChosenExecutor = {
	item: string;
	executor: string;
	model: string;
	hub: string | null;
	pickedBy: string;
	warn: string | null;
};

type RoutingView = Pick<
	PreferRouting,
	"prefer" | "must" | "preferSource" | "mustSource"
>;

const declared = (
	key: string,
	value: string | null,
	source: string | null,
): string[] =>
	value === null ? [] : [`${key}="${value}"${source ? ` (${source})` : ""}`];

/** Quoted prefer=/must= live on the routing plane only; with no executor-chain directive (source "default") the lane silently took the default ladder. */
export const quotedPreferWarning = (
	routing: RoutingView | undefined,
	preference: Pick<PreferDecision, "source">,
	chosen: { executor: string; model: string },
	repo: string,
): string | null => {
	if (!routing || preference.source !== "default") return null;
	const quoted = [
		...declared("must", routing.must, routing.mustSource),
		...declared("prefer", routing.prefer, routing.preferSource),
	];
	if (quoted.length === 0) return null;
	return `WARN — quoted .prefer ${quoted.join(" + ")} is ROUTING-plane only (belt ladder hint, never the executor) and no executor-chain directive applies, so the DEFAULT ladder picked ${chosen.executor} model ${chosen.model} — pin the executor with an unquoted must=<model> in ${repo}/.prefer`;
};

const pickedByOf = (
	preference: PreferenceView,
	route: string | null,
): string => {
	if (route) return `plaid route ${route}`;
	if (preference.source === "posture") return "plaid posture";
	if (preference.source === "dotfile")
		return `.prefer ${preference.directive} line ${String(preference.line)}`;
	return "default ladder";
};

export const chosenExecutor = (a: {
	item: string;
	pick: ChosenPick;
	hub: string | null;
	route: string | null;
	routing: RoutingView | undefined;
	repo: string;
}): ChosenExecutor => {
	const model = laneModelOf(a.pick);
	return {
		item: a.item,
		executor: a.pick.bin,
		model,
		hub: a.hub,
		pickedBy: pickedByOf(a.pick.preference, a.route),
		warn: a.route
			? null
			: quotedPreferWarning(
					a.routing,
					a.pick.preference,
					{ executor: a.pick.bin, model },
					a.repo,
				),
	};
};

export const chosenExecutorLine = (c: ChosenExecutor): string =>
	`executor ${c.item}: ${c.executor} model=${c.model} hub=${c.hub ?? "-"} picked-by=${c.pickedBy}`;

const COLUMNS = ["ITEM", "EXECUTOR", "MODEL", "HUB", "PICKED BY"];

/** The run-tail table of what each lane actually launched with, then each distinct WARN once. */
export const chosenExecutorReport = (rows: ChosenExecutor[]): string | null => {
	if (rows.length === 0) return null;
	const table = [
		COLUMNS,
		...rows.map((c) => [
			c.item,
			c.executor,
			c.model,
			c.hub ?? "-",
			c.warn ? `${c.pickedBy} (WARN: quoted .prefer, no chain)` : c.pickedBy,
		]),
	];
	const widths = COLUMNS.map((_, i) =>
		Math.max(...table.map((r) => r[i]?.length ?? 0)),
	);
	const warns = [...new Set(rows.flatMap((c) => (c.warn ? [c.warn] : [])))];
	return [
		"dispatch executors (what each lane actually launched with):",
		...table.map((r) =>
			r
				.map((cell, i) => cell.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd(),
		),
		...warns,
	].join("\n");
};
