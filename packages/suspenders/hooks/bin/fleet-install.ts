#!/usr/bin/env bun
// hooks/bin/fleet-install.ts — detect-and-prompt installer for hook wiring
// across every CLI/agent target we might run as (W298).
//
// Lifted pattern (not just inspiration — the actual decision flow) from
// vercel-labs/skills (npm `skills`, MIT): detect every known CLI home dir
// on this machine (hooks/lib/vendor/skills-agents.ts, vendored verbatim,
// 70+ targets), then:
//   0 detected  -> full interactive multiselect across all supported targets
//   1 detected  -> auto-select it (unless --agent/-y overrides)
//   2+ detected -> interactive multiselect, pre-populated with the detected set
// Only targets with a suspenders hook adapter (hooks/dialects/<cli>/wire.ts)
// or native wiring (claude-code) are selectable; every other vendored target
// still shows up, gated with a "not yet supported" hint — W296's folder
// pattern plus docs/cli-dialect-pattern.md is how a future one gets added.
//
//   bun hooks/bin/fleet-install.ts                 # detect + prompt
//   bun hooks/bin/fleet-install.ts --agent codex,cline
//   bun hooks/bin/fleet-install.ts --agent '*' -y   # wire every supported target, no prompt
//   bun hooks/bin/fleet-install.ts --dry-run        # print the plan, wire nothing
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
	capabilityCatalog,
	detectFleetTargets,
	type FleetTarget,
	listTargets,
} from "../lib/install/targets.ts";
import {
	applyBuckleRoute,
	planBuckleRoutes,
	renderBuckleRouteTable,
	type IngressProvider,
} from "../lib/hub/buckle-route.ts";

import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const REPO = `${import.meta.dir}/../..`;

interface Flags {
	agent?: string[];
	yes: boolean;
	dryRun: boolean;
	capabilities: boolean;
	buckleRoute: boolean;
	buckleFront?: string;
	buckleLane?: string;
	buckleProvider?: string;
	buckleHome?: string;
}

// W820.2: argv rides verb-kit (W651) — embedded door. -y folds to --yes
// pre-parse (the kit's vocabulary is long flags only); --agent keeps its
// comma-list shape. Unknown flags die (was: silently ignored).
function flagsOf(argv: string[]): Flags {
	const norm = argv.map((a) => (a === "-y" ? "--yes" : a));
	const SPEC = defineVerb({
		name: "fleet-install",
		usage:
			"usage: bun fleet-install.ts [--agent <name|*>] [--yes] [--dry-run] [--capabilities] [--buckle-route] [--buckle-front <url>] [--buckle-lane <slug>] [--buckle-provider zai] [--buckle-home <dir>]",
		flags: [
			"--agent",
			"--buckle-front",
			"--buckle-lane",
			"--buckle-provider",
			"--buckle-home",
		],
		switches: ["--yes", "--dry-run", "--capabilities", "--buckle-route"],
	});
	if (norm.includes("--help") || norm.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		process.exit(0);
	}
	const outcome = parseVerb(SPEC, norm);
	if (!outcome.ok)
		dieFor("fleet-install")(outcome.message || (SPEC.usage ?? ""));
	const parsed = outcome.parsed;
	return {
		agent: parsed
			.flag("--agent")
			?.split(",")
			.map((s) => s.trim()),
		yes: parsed.flag("--yes") === "true",
		dryRun: parsed.flag("--dry-run") === "true",
		capabilities: parsed.flag("--capabilities") === "true",
		buckleRoute: parsed.flag("--buckle-route") === "true",
		buckleFront: parsed.flag("--buckle-front"),
		buckleLane: parsed.flag("--buckle-lane"),
		buckleProvider: parsed.flag("--buckle-provider"),
		buckleHome: parsed.flag("--buckle-home"),
	};
}

function exitCancelled(): never {
	p.cancel("Installation cancelled");
	process.exit(process.stdin.isTTY ? 0 : 1);
}

async function wireTarget(
	target: FleetTarget,
): Promise<{ ok: boolean; note: string }> {
	if (target.native)
		return {
			ok: true,
			note: "native (claude-code reads its own settings.json)",
		};
	if (!target.wireScriptPath) return { ok: false, note: "no wire script" };
	const proc = Bun.spawn(["bun", target.wireScriptPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return {
		ok: code === 0,
		note: (code === 0 ? out : err).trim().split("\n").pop() ?? "",
	};
}

/** W1265 --buckle-route: plan (and, with --yes, write) each detected
 * tool's native route face onto a Buckle named base. Detection rides the
 * SAME catalog pass as hook wiring; this adds only the route-config axis.
 * Front URL is flag-or-env, never guessed (config-over-code). */
async function runBuckleRouteMode(flags: Flags): Promise<void> {
	const front = flags.buckleFront ?? process.env.BUCKLE_ROUTE_FRONT;
	if (front === undefined || front === "") {
		p.log.error(
			"--buckle-route needs --buckle-front <url> (or BUCKLE_ROUTE_FRONT) — refusing to guess a gateway",
		);
		process.exit(1);
	}
	const providerOpt = flags.buckleProvider?.trim() || undefined;
	if (providerOpt !== undefined && providerOpt !== "zai") {
		p.log.error(`unknown --buckle-provider '${providerOpt}' (supported: zai)`);
		process.exit(1);
	}
	const provider = providerOpt as IngressProvider | undefined;
	const spinner = p.spinner();
	spinner.start("Detecting installed CLI/agent targets…");
	const all = await detectFleetTargets(REPO);
	const agents = flags.agent
		? flags.agent.filter((a) => a !== "*")
		: all.filter((t) => t.installed).map((t) => t.type);
	spinner.stop(`${agents.length} target(s) in scope`);
	const plans = planBuckleRoutes({
		agents,
		front,
		lane: flags.buckleLane,
		provider,
		home: flags.buckleHome,
	});
	if (plans.length === 0) {
		p.outro("No detected tool has a Buckle route face — nothing to plan");
		return;
	}
	p.log.message(renderBuckleRouteTable(plans));
	if (flags.dryRun || !flags.yes) {
		p.outro("Plan only — re-run with --yes to write these configs");
		return;
	}
	let wrote = 0;
	for (const plan of plans) {
		const res = applyBuckleRoute(plan);
		if (res.ok) {
			wrote++;
			p.log.success(`${plan.agent} → ${res.path}`);
		} else p.log.error(`${plan.agent}: ${res.why}`);
	}
	p.outro(`Buckle route written to ${wrote}/${plans.length} tool(s)`);
}

async function main(): Promise<void> {
	const flags = flagsOf(process.argv.slice(2));
	p.intro("suspenders fleet-install — wire hook gates across CLI targets");

	if (flags.capabilities) {
		const rows = await capabilityCatalog(REPO);
		p.log.info(
			`${rows.length} catalog targets — ${rows.filter((r) => r.installed).length} detected on this machine`,
		);
		for (const r of rows) {
			if (!r.installed) continue;
			const c = r.capabilities;
			p.log.info(
				`${r.displayName}: skills=${c.skillInstallable} hook-adapter=${c.hookWired} hook-registration=${c.hookRegistration} spawn=${c.headlessSpawnable} resume=${c.sessionResumable} buckle=${c.buckleCompatible}`,
			);
		}
		process.exit(0);
	}

	if (flags.buckleRoute) {
		await runBuckleRouteMode(flags);
		return;
	}

	const spinner = p.spinner();
	spinner.start("Detecting installed CLI/agent targets…");
	const all = await detectFleetTargets(REPO);
	const installed = all.filter((t) => t.installed);
	spinner.stop(
		`${all.length} known targets, ${installed.length} detected on this machine`,
	);

	const supportedInstalled = installed.filter((t) => t.supported);
	const unsupportedInstalled = installed.filter((t) => !t.supported);
	if (unsupportedInstalled.length > 0) {
		p.log.info(
			`Detected but not yet wireable: ${unsupportedInstalled.map((t) => pc.dim(t.displayName)).join(", ")} ` +
				`— see docs/cli-dialect-pattern.md to add one`,
		);
	}

	let selected: FleetTarget[];

	if (flags.agent?.includes("*")) {
		selected = supportedInstalled;
		p.log.info(
			`--agent '*': wiring all ${selected.length} supported detected target(s)`,
		);
	} else if (flags.agent) {
		const byType = new Map(all.map((t) => [t.type, t]));
		selected = flags.agent.map((name) => {
			const t = byType.get(name as FleetTarget["type"]);
			if (!t) {
				p.log.error(`Unknown target: ${name}`);
				process.exit(1);
			}
			if (!t.supported) {
				p.log.error(
					`${t.displayName} has no hook adapter yet (gated) — cannot wire`,
				);
				process.exit(1);
			}
			return t;
		});
	} else if (supportedInstalled.length === 0) {
		if (flags.yes) {
			p.log.warn(
				"No supported targets detected; nothing to wire (pass --agent to force one)",
			);
			selected = [];
		} else {
			const supportedAll = listTargets(REPO).filter((t) => t.supported);
			const choice = await p.multiselect({
				message:
					"No installed targets auto-detected. Select targets to wire anyway:",
				options: supportedAll.map((t) => ({
					value: t.type,
					label: t.displayName,
				})),
				required: false,
			});
			if (p.isCancel(choice)) exitCancelled();
			const chosen = new Set(choice as string[]);
			selected = supportedAll.filter((t) => chosen.has(t.type));
		}
	} else if (supportedInstalled.length === 1 || flags.yes) {
		selected = supportedInstalled;
		p.log.info(
			`Wiring: ${selected.map((t) => pc.cyan(t.displayName)).join(", ")}` +
				(flags.yes && supportedInstalled.length > 1
					? " (-y: all detected, no prompt)"
					: ""),
		);
	} else {
		const choice = await p.multiselect({
			message: "Multiple targets detected. Which ones should get hook wiring?",
			options: supportedInstalled.map((t) => ({
				value: t.type,
				label: t.displayName,
			})),
			initialValues: supportedInstalled.map((t) => t.type),
			required: false,
		});
		if (p.isCancel(choice)) exitCancelled();
		const chosen = new Set(choice as string[]);
		selected = supportedInstalled.filter((t) => chosen.has(t.type));
	}

	if (selected.length === 0) {
		p.outro("Nothing selected — no wiring performed");
		return;
	}

	if (flags.dryRun) {
		for (const t of selected) {
			p.log.step(
				`[dry] ${t.displayName}: ${t.native ? "native" : t.wireScriptPath}`,
			);
		}
		p.outro(
			`--dry-run: ${selected.length} target(s) would be wired, nothing touched`,
		);
		return;
	}

	for (const t of selected) {
		const result = await wireTarget(t);
		if (result.ok) p.log.success(`${t.displayName}: ${result.note}`);
		else p.log.error(`${t.displayName}: ${result.note}`);
	}

	p.outro(`Done — ${selected.length} target(s) processed`);
}

await main();
