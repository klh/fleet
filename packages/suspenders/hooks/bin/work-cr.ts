// hooks/bin/work-cr.ts — W352 work delegation CLI over the W160/W193 CR
// channel. The control plane's declare surface: maps a local work-graph item
// to a CR and declares it on the buckle hub (buckle:admin:WRITE_), lists the
// hub queue, or manually reports a status transition (ops/debug). Env:
//   BUCKLE_HUB_URL     hub base URL (or --hub <url>)
//   BUCKLE_ADMIN_KEY   hub-admin capability (declare + list)
//   BUCKLE_SPOKE_TOKEN spoke capability (report)
// usage:
//   work-cr declare <itemId> --as <sid> [--hub <url>] [--timeout-ms n]
//   work-cr list [--hub <url>]
//   work-cr report <crId> --state <declared|delivered|applied|failed> [--note "..."]

import { openStore, projectIdentity } from "../lib/govdb.ts";
import {
	defineVerb,
	parseVerb,
	renderRegistryHelp,
	type VerbSpec,
} from "../lib/verb-kit.ts";
import {
	declareWorkCr,
	fetchCrQueue,
	reportCrStatus,
	WORK_CR_ACTION,
	WORK_CR_TARGET_PREFIX,
} from "../lib/work-cr.ts";

const die = (m: string): never => {
	console.error(`work-cr: ${m}`);
	process.exit(2);
};

const hubUrlOf = (hub: string | null): string =>
	(hub ?? process.env.BUCKLE_HUB_URL ?? "").replace(/\/$/, "");
const adminKey = process.env.BUCKLE_ADMIN_KEY ?? null;
const spokeKey = process.env.BUCKLE_SPOKE_TOKEN ?? null;

// W820.2: argv rides verb-kit (W651) — embedded door over three declared
// verbs; the kit owns parse/reqFlags/minPos/help/die-format. (fleet.ts and
// review-lane.ts took the same door in W820.)
const VERBS: VerbSpec[] = [
	defineVerb({
		name: "declare",
		usage:
			"usage: work-cr declare <itemId> --as <sid> [--hub <url>] [--timeout-ms n]",
		flags: ["--as", "--hub", "--timeout-ms"],
		reqFlags: ["--as"],
		minPos: 1,
	}),
	defineVerb({
		name: "list",
		usage: "usage: work-cr list [--hub <url>]",
		flags: ["--hub"],
	}),
	defineVerb({
		name: "report",
		usage:
			'usage: work-cr report <crId> --state <declared|delivered|applied|failed> [--note "..."]',
		flags: ["--state", "--note", "--hub"],
		reqFlags: ["--state"],
		minPos: 1,
	}),
];

const TOKENS = process.argv.slice(2);
const HEAD = TOKENS[0];
const SPEC = VERBS.find((v) => v.name === HEAD);
if (HEAD === undefined || HEAD === "--help" || HEAD === "-h") {
	console.log(
		renderRegistryHelp(
			"work-cr",
			"work delegation CLI over the W160/W193 CR channel (W352)",
			VERBS,
		),
	);
	process.exit(HEAD === undefined ? 2 : 0);
}
if (!SPEC) die(`unknown command — try ${VERBS.map((v) => v.name).join(" | ")}`);
const outcome = parseVerb(SPEC, TOKENS.slice(1));
if (!outcome.ok) die(outcome.message || (SPEC.usage ?? ""));
const parsed = outcome.parsed;
const cmd = parsed.name;
const [itemArg] = parsed.pos;
const hubUrl = hubUrlOf(parsed.flag("--hub"));
const as = parsed.flag("--as");
const state = parsed.flag("--state");
const note = parsed.flag("--note");
const timeoutMs = Number(parsed.flag("--timeout-ms") ?? "5000") || 5000;

if (cmd === "declare") {
	if (hubUrl.length === 0) die("no hub URL (BUCKLE_HUB_URL or --hub)");
	if (adminKey === null) die("no admin key (BUCKLE_ADMIN_KEY)");
	const db = openStore();
	const item = db
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(projectIdentity(), itemArg) as Record<string, unknown> | null;
	if (item === null || item === undefined)
		die(`no such work item in this project: ${itemArg}`);
	const title = typeof item.title === "string" ? item.title : "";
	if (title.length === 0)
		die(`item ${itemArg} has no title (never declare an unfilled item)`);
	const desc = typeof item.description === "string" ? item.description : null;
	const out = await declareWorkCr({
		hubUrl,
		adminKey,
		timeoutMs,
		spec: {
			id: `wcr-${itemArg}`,
			action: WORK_CR_ACTION,
			target: `${WORK_CR_TARGET_PREFIX}${itemArg}`,
			payload: { title, description: desc, priority: item.priority },
			origin: { system: "suspenders", actor: as },
		},
	});
	if (!out.ok) die(`declare failed: ${out.reason ?? String(out.status)}`);
	console.log(
		`[work-cr] declared ${out.cr?.id} target=${out.cr?.target} state=${out.cr?.state}`,
	);
} else if (cmd === "list") {
	if (hubUrl.length === 0) die("no hub URL (BUCKLE_HUB_URL or --hub)");
	if (adminKey === null) die("no admin key (BUCKLE_ADMIN_KEY)");
	const q = await fetchCrQueue(hubUrl, adminKey, timeoutMs).catch((e) =>
		die(`hub unreachable: ${String(e)}`),
	);
	for (const cr of q)
		console.log(
			`${cr.id}\t${cr.action}\t${cr.target}\t${cr.state}${cr.note === null || cr.note === undefined ? "" : `\t${cr.note}`}`,
		);
	if (q.length === 0) console.log("(queue empty)");
} else if (cmd === "report") {
	if (hubUrl.length === 0) die("no hub URL (BUCKLE_HUB_URL --hub)");
	if (spokeKey === null) die("no spoke key (BUCKLE_SPOKE_TOKEN)");
	const r = await reportCrStatus({
		hubUrl,
		spokeKey,
		id: itemArg,
		state,
		note,
		timeoutMs,
	});
	if (!r.ok && !r.converged)
		die(`report failed: ${r.reason ?? String(r.status)}`);
	console.log(
		`[work-cr] ${itemArg} → ${state}${r.ok ? "" : " (already converged)"}${note !== null ? ` note=${note}` : ""}`,
	);
}
