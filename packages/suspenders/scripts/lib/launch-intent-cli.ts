// launch-intent-cli.ts — `dispatch intent <inspect|fail>` (W724): the
// operator door for lane_launch_intents. Dispatch's fail-closed launch
// check ("durable launch intent alive or uncertain") and work reclaim's
// claim liveness both trust inspectLaunchIntent — but only the dispatcher's
// own unwind (launch-cleanup) could ever set state='FAILED'. A dispatcher
// that died mid-launch leaves the row wedged non-FAILED with a pid that
// can never re-probe dead — the item becomes undispatchable and its claim
// unclaimable. Same doctrine as the W636 registry prune: liveness-guarded,
// evidence-required, refusal over silence.
import {
	finishFailedLaunch,
	inspectLaunchIntent,
	launchIntent,
	launchSchema,
} from "./launch-fencing.ts";
import { openStore, projectIdentity } from "../../hooks/lib/govdb.ts";
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
	type Parsed,
	type VerbSpec,
} from "../../hooks/lib/verb-kit.ts";

const TABLE = "lane_launch_intents";

// W651: help generated, parsing rides the kit's pure door (embedded main:
// the caller owns exit codes: 0 answered · 1 refused/absent · 2 usage).
const VERBS: VerbSpec[] = [
	defineVerb({
		name: "inspect",
		usage:
			"usage: inspect [--item <Wn>] [--json] — launch intents + liveness verdicts",
		flags: ["--item"],
		switches: ["--json"],
		lax: true,
	}),
	defineVerb({
		name: "reconcile-birth",
		usage:
			"usage: reconcile-birth --item <Wn> --evidence <0600-json> [--apply] — local OS operator prepares then explicitly applies audited birth repair for an exact live PAUSED claim; never authenticates a caller-supplied SID",
		flags: ["--item", "--evidence"],
		switches: ["--apply"],
	}),
	defineVerb({
		name: "fail",
		usage:
			"usage: fail --item <Wn> --evidence <why> — mark a wedged intent FAILED, never a live lane",
		flags: ["--item", "--evidence"],
		lax: true,
	}),
];

const HELP = VERBS.map((v) => renderVerbHelp(v) ?? "").join("\n");

/** Verdicts for every intent of one project, plus the raw row. */
export const inspectIntents = (
	store: Parameters<typeof launchSchema>[0],
	project: string,
): Array<Record<string, unknown> & { verdict: string }> => {
	launchSchema(store);
	const rows = store
		.query(`SELECT * FROM ${TABLE} WHERE project=? ORDER BY item`)
		.all(project) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		...r,
		verdict: inspectLaunchIntent(r as never),
	}));
};

type Store = Parameters<typeof launchSchema>[0];

const listJson = (store: Store, project: string): number => {
	console.log(JSON.stringify(inspectIntents(store, project)));
	return 0;
};

const listPlain = (store: Store, project: string): number => {
	const rows = inspectIntents(store, project);
	if (rows.length === 0) {
		console.log(`no launch intents for ${project}`);
		return 0;
	}
	for (const r of rows) {
		const pid = r.pid as number | null;
		console.log(
			[
				r.verdict,
				r.item,
				`sid=${String(r.sid)}`,
				`state=${String(r.state)}`,
				`pid=${pid ? String(pid) : "-"}`,
				`executor=${String(r.executor ?? "-")}`,
				`attempt=${String(r.attempt ?? "-")}`,
			].join("  "),
		);
	}
	return 0;
};

/** The fail: liveness-guarded. Absent → refused; alive → refused (a
 * hand-fail would orphan a running lane); already FAILED → idempotent ok;
 * dead/unknown → FAILED with the evidence banked as a bus event. */
export const failIntent = (
	store: Parameters<typeof launchSchema>[0],
	project: string,
	item: string,
	evidence: string,
): { ok: boolean; line: string } => {
	const prior = launchIntent(store, project, item);
	if (!prior) return { ok: false, line: `no launch intent for ${item}` };
	const verdict = inspectLaunchIntent(prior);
	if (verdict === "alive")
		return {
			ok: false,
			line: `refused: ${item} intent is alive (pid ${String(prior.pid)}) — failing it would orphan a running lane`,
		};
	if (verdict === "dead" && prior.state === "FAILED")
		return { ok: true, line: `${item} intent already FAILED` };
	if (evidence.trim().length < 8)
		return {
			ok: false,
			line: "refused: --evidence must name the death (8+ chars)",
		};
	finishFailedLaunch(store, prior);
	store.run(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?,?,?,?,?,?)",
		Date.now(),
		"dispatch-intent",
		"dispatch.intent.failed",
		null,
		JSON.stringify({ item, evidence, sid: prior.sid, pid: prior.pid }),
		null,
	);
	return {
		ok: true,
		line: `${item} intent FAILED (was ${prior.state}, verdict ${verdict}) — evidence banked`,
	};
};

const failVerb = (store: Store, project: string, parsed: Parsed): number => {
	const item = parsed.flag("--item");
	if (!item) {
		console.log(HELP);
		return 2;
	}
	const out = failIntent(store, project, item, parsed.flag("--evidence") ?? "");
	console.log(out.line);
	return out.ok ? 0 : 1;
};

/** The `dispatch intent` door. Opens the machine store unless one is
 * injected (ctx.store — the test seam); closes only what it opened. */
export const intentMain = (
	args: string[],
	ctx: { repo: string; store?: Store },
): number => {
	const project = projectIdentity(ctx.repo);
	const [verb = "", ...rest] = args;
	if (!verb || verb === "help") {
		console.log(HELP);
		return verb ? 0 : 2;
	}
	const spec = VERBS.find((v) => v.name === verb);
	if (!spec) {
		console.log(HELP);
		return 2;
	}
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(renderVerbHelp(spec) ?? HELP);
		return 0;
	}
	const outcome = parseVerb(spec, rest);
	if (!outcome.ok) {
		console.log(HELP);
		return 2;
	}
	if (spec.name === "reconcile-birth") {
		const item = outcome.parsed.flag("--item");
		const evidence = outcome.parsed.flag("--evidence");
		if (!item || !evidence) {
			console.log(renderVerbHelp(spec));
			return 2;
		}
		// Lazy import keeps ordinary inspection/help free of restart authority.
		const { intentBirthReconcile } =
			require("./intent-birth-reconcile.ts") as typeof import("./intent-birth-reconcile.ts");
		intentBirthReconcile(
			ctx.repo,
			item,
			evidence,
			outcome.parsed.flag("--apply") === "true",
		);
		return 0;
	}
	const store = ctx.store ?? openStore();
	let code: number;
	if (spec.name === "inspect") {
		const json = outcome.parsed.all("--json").length > 0;
		code = json ? listJson(store, project) : listPlain(store, project);
	} else {
		code = failVerb(store, project, outcome.parsed);
	}
	if (!ctx.store) store.close();
	return code;
};
