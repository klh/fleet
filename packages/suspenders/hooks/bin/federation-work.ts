// hooks/bin/federation-work.ts — W370 the verb half of the federated work
// view: one command runs one pull cycle over the declared edges and prints
// the whole view — LOCAL first (this machine's open work), then one scope
// per peer (the work THEY are responsible for), degraded edges honestly
// marked with the last-known counts. --json emits the raw view wire.
// Degrades per edge (lib law): a downed peer never fails the view.
import {
	FEDERATION_WORK_TOKEN_ENV,
	type FedWorkRow,
	federatedWorkView,
} from "../lib/federation-work.ts";
import { defineVerb, runCli } from "../lib/verb-kit.ts";

function rowLine(r: FedWorkRow): string {
	const feed = r.feed;
	const counts =
		feed === null
			? "no feed"
			: `open=${String(feed.total)} shown=${String(feed.items.length)}${feed.trunc ? "+" : ""}`;
	const when = r.pulled_at ?? "never";
	const state = r.ok
		? "live"
		: `degraded (${r.reason ?? "unknown"})${feed === null ? "" : " — last-known"}`;
	return `  ${r.label} [${state}] ${counts} via=${r.via ?? "?"} at=${when}`;
}

function textView(v: Awaited<ReturnType<typeof federatedWorkView>>): string {
	const lines: string[] = [];
	lines.push(
		`federated work view — me=${v.me} edges=${String(v.peers.length)}`,
	);
	lines.push(
		`LOCAL ${v.local.hub}: open=${String(v.local.total)} shown=${String(v.local.items.length)}${v.local.trunc ? "+" : ""}`,
	);
	for (const it of v.local.items)
		lines.push(`  ${it.id} [${it.state}] ${it.title}`);
	for (const p of v.peers) {
		lines.push(rowLine(p));
		for (const it of p.feed?.items ?? [])
			lines.push(`  ${it.id} [${it.state}] ${it.title}`);
	}
	if (v.peers.length === 0)
		lines.push(
			`no peer edges declared (${FEDERATION_WORK_TOKEN_ENV} + HUB_PEERS/stack.json peers.light edges up)`,
		);
	return lines.join("\n");
}

if (import.meta.main) {
	const argv = [
		"bun",
		"hooks/bin/federation-work.ts",
		...process.argv.slice(2),
	];
	await runCli({
		prog: "federation-work",
		about: "federation-work — W370 federated work view: one pull + one print.",
		verbs: [
			defineVerb({
				name: "show",
				usage:
					"usage: federation-work show [--json] — one pull cycle over the declared edges, then the view",
				switches: ["--json"],
			}),
		],
		defaultVerb: "show",
		argv,
		dispatch: async (name, parsed) => {
			void name;
			const json = parsed.flag("--json") === "true";
			const view = await federatedWorkView();
			if (json) console.log(JSON.stringify(view));
			else console.log(textView(view));
			const degraded = view.peers.filter((p) => p.degraded).length;
			for (const p of view.peers)
				if (p.degraded)
					console.error(`[federation-work] ${p.label}: ${p.reason}`);
			return degraded === view.peers.length && view.peers.length > 0 ? 2 : 0;
		},
	});
}
