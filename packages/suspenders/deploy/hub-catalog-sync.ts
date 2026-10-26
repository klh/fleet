#!/usr/bin/env bun
// W1711: operator-invoked hub catalog reconciliation. `check` is the dry run
// (authenticated provider GETs, a printed report, an optional 0600 plan);
// `apply` lands exactly one reviewed plan. Output carries verdicts and
// counts only — never a key, a key path or stack contents. Exit 3 = the
// stack moved or is locked and nothing was written; exit 1 = refused.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultCapabilitySnapshotPath } from "@klh/belt/bin/model-capabilities.ts";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { STACK_PATH } from "../hooks/lib/stack-config.ts";
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import {
	applyCatalogPlan,
	CatalogConflict,
	type CatalogCheck,
	checkHubCatalog,
} from "./hub-catalog.ts";

const PROG = "hub-catalog-sync";

const fail = (error: unknown): number => {
	console.error(`${PROG}: ${error instanceof Error ? error.message : "failed"}`);
	return error instanceof CatalogConflict ? 3 : 1;
};

const readPlan = (path: string): unknown => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("plan file is missing or not valid JSON");
	}
};

const printCheck = ({ reports, plan }: CatalogCheck): void => {
	const verdicts = new Map<string, number>();
	for (const report of reports) {
		const detail = report.detail ? ` (${report.detail})` : "";
		const flagged = report.flagged ? " [flagged]" : "";
		console.log(
			`${report.group}[${report.index}] ${report.model} ${report.verdict} wire=${report.wire}${detail}${flagged}`,
		);
		verdicts.set(report.verdict, (verdicts.get(report.verdict) ?? 0) + 1);
	}
	const counts = [...verdicts].map(([verdict, n]) => `${verdict}=${n}`).join(" ");
	const ops = plan.actions.map((a) => `${a.op} ${a.group}[${a.index}]`).join(", ");
	console.log(
		`${reports.length} rows (${counts || "none"}); ${plan.actions.length} actions${ops ? `: ${ops}` : ""}; ${plan.capabilities.length} capability records`,
	);
};

await runCli({
	prog: PROG,
	about: "Reconcile a hub's upstream rows against authenticated provider catalogs.",
	verbs: [
		defineVerb({
			name: "check",
			usage: `usage: ${PROG} check --hub <hub-name> [--remove-stale] [--plan-out <path>]`,
			flags: ["--hub", "--plan-out"],
			switches: ["--remove-stale"],
			reqFlags: ["--hub"],
			run: async (parsed) => {
				try {
					const stackPath = STACK_PATH();
					const planOut = parsed.flag("--plan-out");
					if (planOut && resolve(planOut) === resolve(stackPath))
						throw new Error("--plan-out must not name the stack file");
					const removeStale = parsed.flag("--remove-stale") === "true";
					const hub = parsed.flag("--hub") ?? "";
					const result = await checkHubCatalog({ hub, stackPath, removeStale });
					printCheck(result);
					if (!planOut) return;
					atomicWrite0600(resolve(planOut), `${JSON.stringify(result.plan, null, "\t")}\n`);
					console.log(`plan written 0600; review it, then: ${PROG} apply --plan ${planOut}`);
				} catch (error) {
					return fail(error);
				}
			},
		}),
		defineVerb({
			name: "apply",
			usage: `usage: ${PROG} apply --plan <path>`,
			flags: ["--plan"],
			reqFlags: ["--plan"],
			run: async (parsed) => {
				try {
					const plan = readPlan(parsed.flag("--plan") ?? "");
					const capabilitiesPath = defaultCapabilitySnapshotPath();
					const result = await applyCatalogPlan({ plan, stackPath: STACK_PATH(), capabilitiesPath });
					const backup = result.backup ? `; backup ${result.backup}` : "";
					console.log(
						`${result.changed ? "applied" : "stack unchanged"}: ${result.actions} stack actions, ${result.capabilities} capability records${backup}`,
					);
				} catch (error) {
					return fail(error);
				}
			},
		}),
	],
});
