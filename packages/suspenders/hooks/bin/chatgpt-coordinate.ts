#!/usr/bin/env bun
// hooks/bin/chatgpt-coordinate.ts — W1013 CLI face (hooks/lib/
// chatgpt-coordinate.ts is the logic): one fire of the WS-native ChatGPT
// auto-coordinate loop. The fleet-loop maintenance registry (W779) fires it
// every 10 min with --repo. Disabled until the machine-level config opts in
// (~/.config/klh/chatgpt-coordinate.yaml; no file = idle), SUSPENDERS_CHATGPT_COORD=0
// or the .fleet/chatgpt-auto-paused marker kill it for ops.
//   bun hooks/bin/chatgpt-coordinate.ts [--repo <dir>] [--dry-run] [--json]
import { join } from "node:path";
import {
	createBoardWire,
	createChatGptCoordinator,
	loadChatGptCoordConfig,
} from "../lib/plaid/chatgpt-coordinate.ts";
import { openStore } from "../lib/govdb/govdb-store.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "chatgpt-coordinate",
	usage: "usage: bun chatgpt-coordinate.ts [--repo <dir>] [--dry-run] [--json]",
	flags: ["--repo"],
	switches: ["--dry-run", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("chatgpt-coordinate")(outcome.message || (SPEC.usage ?? ""));

const val = (flag: string): string | undefined =>
	outcome.parsed.flag(flag) ?? undefined;
const repo = val("--repo") ?? process.cwd();
const config = loadChatGptCoordConfig();

const disabled = (why: string): never => {
	console.log(`chatgpt-coordinate: ${why}`);
	process.exit(0);
};

if (process.env.SUSPENDERS_CHATGPT_COORD === "0")
	disabled("disabled (SUSPENDERS_CHATGPT_COORD=0)");
if (!config)
	disabled("no config (machine-level chatgpt-coordinate.yaml missing)");

const project = repo;
const itemInfo = (
	itemId: string,
): { title: string | null; state: string | null } => {
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const row = store
			.query("SELECT title, state FROM work_items WHERE id = ? AND project = ?")
			.get(itemId, project) as { title: string; state: string } | null;
		return row
			? { title: row.title, state: row.state }
			: { title: null, state: null };
	} catch {
		return { title: null, state: null };
	} finally {
		store?.close();
	}
};

const run = createChatGptCoordinator({
	config,
	project,
	repo,
	statePath: join(repo, ".fleet", "chatgpt-coordinate.json"),
	wire: createBoardWire(config, project),
	itemInfo,
	log: (m) => console.log(m),
});

if (outcome.parsed.flag("--dry-run") === "true") {
	// scan + compose only: report what WOULD be asked, touch no wire
	const {
		scanTriggers,
		composeBrief,
		loadState,
		pausedMarker: pm,
	} = await import("../lib/plaid/chatgpt-coordinate.ts");
	if (outcome.parsed.flag("--json") === "true") {
		let store: ReturnType<typeof openStore> | null = null;
		let triggers: ReturnType<typeof scanTriggers> = [];
		try {
			store = openStore();
			triggers = scanTriggers(store, {
				project,
				config,
				state: loadState(join(repo, ".fleet", "chatgpt-coordinate.json")),
				repo,
			});
		} finally {
			store?.close();
		}
		console.log(
			JSON.stringify({
				paused: pm(repo),
				triggers: triggers.map((t) => ({
					cls: t.cls,
					identity: t.identity,
					itemId: t.itemId,
					brief: composeBrief(t, { maxLines: config.briefMaxLines, repo }),
				})),
			}),
		);
		process.exit(0);
	}
	console.log(
		`chatgpt-coordinate: dry-run (paused marker: ${pm(repo)}) — use --json for the trigger set`,
	);
	process.exit(0);
}

const r = await run();
if (outcome.parsed.flag("--json") === "true") {
	console.log(JSON.stringify(r));
} else {
	console.log(
		`chatgpt-coordinate: ${r.status} · asked ${r.asked.length} · deduped ${r.deduped.length} · drained ${r.drained.length} · errors ${r.errors.length}`,
	);
	for (const e of r.errors) console.log(`  error: ${e}`);
}
if (r.status === "error" && r.errors.length > 0) process.exit(1);
