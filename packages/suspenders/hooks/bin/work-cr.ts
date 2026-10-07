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
import {
	fetchCrQueue,
	declareWorkCr,
	reportCrStatus,
	WORK_CR_ACTION,
	WORK_CR_TARGET_PREFIX,
} from "../lib/work-cr.ts";
import { openStore, projectIdentity } from "../lib/govdb.ts";

const die = (m: string): never => {
	console.error(`work-cr: ${m}`);
	process.exit(2);
};

function usage(): never {
	console.log(`usage:
  work-cr declare <itemId> --as <sid> [--hub <url>] [--timeout-ms n]
  work-cr list [--hub <url>]
  work-cr report <crId> --state <state> [--note "..."]`);
	process.exit(0);
}

// argv scan — boring, inspectable; --value or --value x both accepted
let positional: string[] = [];
let hub: string | null = null;
let as: string | null = null;
let state: string | null = null;
let note: string | null = null;
let timeoutMs = 5000;
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i++) {
	const a = rest[i];
	if (a === "--help") usage();
	else if (a === "--hub") hub = rest[++i] ?? null;
	else if (a === "--as") as = rest[++i] ?? null;
	else if (a === "--state") state = rest[++i] ?? null;
	else if (a === "--note") note = rest[++i] ?? null;
	else if (a === "--timeout-ms") timeoutMs = Number(rest[++i] ?? "5000") || 5000;
	else if (a.startsWith("--")) die(`unknown flag: ${a}`);
	else positional.push(a);
}
const cmd = positional[0];
const itemArg = positional[1];

const hubUrl = (hub ?? process.env.BUCKLE_HUB_URL ?? "").replace(/\/$/, "");
const adminKey = process.env.BUCKLE_ADMIN_KEY ?? null;
const spokeKey = process.env.BUCKLE_SPOKE_TOKEN ?? null;

if (cmd === "declare") {
	if (itemArg === undefined) die("declare needs a work item id");
	if (hubUrl.length === 0) die("no hub URL (BUCKLE_HUB_URL or --hub)");
	if (adminKey === null) die("no admin key (BUCKLE_ADMIN_KEY)");
	if (as === null) die("declare needs --as <sid> (the origin actor)");
	const db = openStore();
	const item = db
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(projectIdentity(), itemArg) as Record<string, unknown> | null;
	if (item === null || item === undefined)
		die(`no such work item in this project: ${itemArg}`);
	const title = typeof item.title === "string" ? item.title : "";
	if (title.length === 0) die(`item ${itemArg} has no title (never declare an unfilled item)`);
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
	if (itemArg === undefined) die("report needs a CR id");
	if (hubUrl.length === 0) die("no hub URL (BUCKLE_HUB_URL --hub)");
	if (spokeKey === null) die("no spoke key (BUCKLE_SPOKE_TOKEN)");
	if (state === null) die("report needs --state <declared|delivered|applied|failed>");
	const r = await reportCrStatus({
		hubUrl,
		spokeKey,
		id: itemArg,
		state,
		note,
		timeoutMs,
	});
	if (!r.ok && !r.converged) die(`report failed: ${r.reason ?? String(r.status)}`);
	console.log(
		`[work-cr] ${itemArg} → ${state}${r.ok ? "" : " (already converged)"}${note !== null ? ` note=${note}` : ""}`,
	);
} else usage();
