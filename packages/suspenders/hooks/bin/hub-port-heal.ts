#!/usr/bin/env bun
// hooks/bin/hub-port-heal.ts — CLI face of the W2309 hub port-publishing
// self-heal (hooks/lib/fleet-loop/hub-port-heal.ts). For every live hub
// profile in the machine stack conf: probe; on the exact port-loss signature
// (health face red + container healthy + NetworkSettings.Ports empty) run
// the matching remedy once — remote = hubctl up, local Docker Desktop =
// compose up -d --force-recreate — then re-probe. Docker Desktop down is a
// DISTINCT degraded state: reported, never auto-launched.
//
//   bun hooks/bin/hub-port-heal.ts [--act] [--json] [--hub <name>]
//
// Dry-run is the default (monitor doctrine: alerts first); --act heals.
// The fleet-loop maintenance registry (W779) fires it with --act every
// 15 min. Act runs with a remedy or a docker-down verdict emit a plane
// event + a BROADCAST (heal/no-heal) and bank a lesson fact update.
// Exit: 1 when a dry-run finds the signature or any run saw docker-down /
// unhealed loss (a human should notice), else 0.
import { join } from "node:path";
import { broadcastNote } from "../coord/bus.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import {
	healTargets,
	type HubHealTarget,
	realHubExec,
	runLocal,
} from "../lib/fleet-loop/hub-port-heal.ts";
import { inQuietHours, loadStack } from "../lib/stack-config.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

export function toTarget(
	name: string,
	hub: {
		deploy?: { ssh?: string; docker?: string; dir?: string };
		quiet_hours?: string;
		buckle_health_port?: number;
		board_health_port?: number;
		store_health_port?: number;
		belt_health_port?: number;
		belt_model?: { health_port?: number };
		knowledge?: { health_port?: number };
		model_store_health_port?: number;
	},
): HubHealTarget | null {
	if (!hub.deploy?.dir) return null;
	const probePorts = [
		hub.buckle_health_port ?? 4112,
		hub.board_health_port ?? 7800,
		hub.store_health_port ?? 7794,
		hub.belt_health_port ?? 7790,
		hub.belt_model?.health_port,
		hub.knowledge?.health_port,
		hub.model_store_health_port ?? 7793,
	].filter((p): p is number => typeof p === "number" && p > 0);
	return {
		name,
		ssh: hub.deploy.ssh,
		docker: hub.deploy.docker ?? "docker",
		dir: hub.deploy.dir,
		connectTimeout: hub.deploy.connect_timeout,
		probePorts,
	};
}

// the remote remedy face — resolved against THIS package's deploy dir
const hubctlPath = join(import.meta.dir, "../../deploy/hubctl.ts");

async function main(argv: string[]): Promise<number> {
	const SPEC = defineVerb({
		name: "hub-port-heal",
		usage:
			"usage: bun hub-port-heal.ts [--act] [--json] [--hub <name>] — dry-run default",
		flags: ["--hub"],
		switches: ["--act", "--json"],
	});
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const outcome = parseVerbSafe(SPEC, argv);
	if (!outcome.ok) {
		console.error(outcome.message || (SPEC.usage ?? ""));
		return 2;
	}
	const act = outcome.parsed.flag("--act") === "true";
	const json = outcome.parsed.flag("--json") === "true";
	const only = outcome.parsed.flag("--hub") ?? undefined;

	const stack = loadStack();
	const targets: HubHealTarget[] = [];
	for (const [name, hub] of Object.entries(stack.hubs)) {
		if (only && name !== only) continue;
		// W483 posture: inside the hub's quiet-hours window it is EXPECTED
		// dark — never probe, never heal into a nightly poweroff
		if (inQuietHours(hub)) continue;
		const t = toTarget(name, hub);
		if (t) targets.push(t);
	}

	const exec = realHubExec(30_000);
	const spawnLocal = (
		cmd: string[],
		timeoutMs: number,
	): { code: number; out: string } => runLocal(cmd, timeoutMs);
	const reports = healTargets(targets, {
		act,
		exec,
		spawn: spawnLocal,
		bun: process.execPath,
		hubctlPath,
	});

	if (json) console.log(JSON.stringify({ act, reports }, null, 2));
	else
		for (const r of reports)
			console.log(`${r.hub}: ${r.verdict}${r.detail ? ` — ${r.detail}` : ""}`);

	const loss = reports.filter((r) => r.verdict === "port-loss");
	const down = reports.filter((r) => r.verdict === "docker-down");
	if (act && (loss.length > 0 || down.length > 0)) surface(loss, down);

	const attention =
		(!act && loss.length > 0) || down.length > 0 || loss.some((r) => !r.healed);
	return attention ? 1 : 0;
}

// act-mode surfacing: ONE plane event + ONE BROADCAST (the bus dedupes the
// same note for 24h) + the lesson fact update (best-effort, never fatal)
function surface(
	loss: { hub: string; remedied: boolean; healed: boolean; detail: string }[],
	down: { hub: string }[],
): void {
	try {
		emitLoopEvent("plane.hub-port-heal", "plane", { loss, down });
	} catch {}
	try {
		const healed = loss.filter((r) => r.healed).map((r) => r.hub);
		const stuck = loss.filter((r) => r.remedied && !r.healed).map((r) => r.hub);
		const pending = loss.filter((r) => !r.remedied).map((r) => r.hub);
		const parts: string[] = [];
		if (healed.length) parts.push(`healed ${healed.join(",")}`);
		if (stuck.length) parts.push(`STILL RED after remedy: ${stuck.join(",")}`);
		if (pending.length) parts.push(`remedy pending: ${pending.join(",")}`);
		if (down.length)
			parts.push(
				`docker daemon DOWN (not auto-launched): ${down.map((d) => d.hub).join(",")}`,
			);
		if (parts.length)
			broadcastNote(`[hub-port-heal] ${parts.join(" · ")}`, "hub-port-heal");
	} catch {}
	try {
		if (loss.length)
			runLocal(
				[
					process.execPath,
					join(import.meta.dir, "coord.ts"),
					"fact",
					"set",
					"lesson.hub-port-heal",
					"--text",
					`W2309 auto-heal fire ${new Date().toISOString()}: ${loss.map((r) => `${r.hub} remedied=${r.remedied} healed=${r.healed}`).join("; ")}`,
					"--source",
					"hub-port-heal",
				],
				15_000,
			);
	} catch {}
}

// parseVerb wrapped so an argv failure is a return, not a die (importable)
function parseVerbSafe(
	spec: ReturnType<typeof defineVerb>,
	argv: string[],
):
	| { ok: true; parsed: { flag: (f: string) => string | boolean | undefined } }
	| { ok: false; message: string } {
	const r = parseVerb(spec, argv);
	if (!r.ok || !r.parsed)
		return { ok: false, message: r.message ?? "bad argv" };
	return {
		ok: true,
		parsed: r.parsed as { flag: (f: string) => string | boolean | undefined },
	};
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
